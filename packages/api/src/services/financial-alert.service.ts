import { createHash } from 'node:crypto';
import type { DbExecutor, FinancialAlertEvidence, FinancialAlertRule } from '@fc/db';
import {
  accounts,
  creditCardBills,
  creditCardConfigs,
  faturaImports,
  financialAlerts,
  purchaseObservations,
} from '@fc/db';
import { Money, recurringCandidates } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { settlementDateKey } from '../lib/settlement-guards.ts';
import { AuditService } from './audit.service.ts';
import { BalanceProjectionService } from './balance-projection.service.ts';
import { BudgetService, budgetPeriodSchema } from './budget.service.ts';
import { CashReadinessService } from './cash-readiness.service.ts';
import { ForecastContextService } from './forecast-context.service.ts';

export const financialAlertStateSchema = z.object({
  id: z.guid(),
  revision: z.number().int().positive(),
  state: z.enum(['open', 'read', 'muted', 'resolved']),
});
type Candidate = { rule: FinancialAlertRule; entityKey: string; evidence: FinancialAlertEvidence };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class FinancialAlertService {
  constructor(
    private db: DbExecutor,
    private now: () => Date = () => new Date(),
  ) {}
  private period(raw?: z.input<typeof budgetPeriodSchema>) {
    const day = settlementDateKey(this.now());
    return budgetPeriodSchema.parse(
      raw ?? { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) },
    );
  }
  async list(userId: string, raw?: z.input<typeof budgetPeriodSchema>) {
    const { month, year } = this.period(raw);
    const items = await this.db
      .select()
      .from(financialAlerts)
      .where(
        and(
          eq(financialAlerts.userId, userId),
          eq(financialAlerts.month, month),
          eq(financialAlerts.year, year),
        ),
      )
      .orderBy(desc(financialAlerts.updatedAt), financialAlerts.id)
      .limit(501);
    return { month, year, items: items.slice(0, 500), truncated: items.length > 500 };
  }
  async setState(userId: string, raw: z.input<typeof financialAlertStateSchema>) {
    const input = financialAlertStateSchema.parse(raw),
      now = this.now();
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const [before] = await db
        .select()
        .from(financialAlerts)
        .where(
          and(
            eq(financialAlerts.userId, userId),
            eq(financialAlerts.id, input.id),
            eq(financialAlerts.revision, input.revision),
          ),
        )
        .for('update');
      if (!before) throw new TRPCError({ code: 'CONFLICT', message: 'Alert changed; reload' });
      if (!before.active && input.state !== 'resolved')
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Alert condition is inactive; refresh the source evidence',
        });
      const [row] = await db
        .update(financialAlerts)
        .set({
          state: input.state,
          revision: input.revision + 1,
          readAt: input.state === 'read' ? now : before.readAt,
          mutedAt: input.state === 'muted' ? now : input.state === 'open' ? null : before.mutedAt,
          resolvedAt: input.state === 'resolved' ? now : null,
        })
        .where(and(eq(financialAlerts.id, input.id), eq(financialAlerts.userId, userId)))
        .returning();
      await new AuditService(db).log(userId, 'review', 'financial_alert', row.id, before, row);
      return row;
    });
  }
  async refresh(userId: string, raw?: z.input<typeof budgetPeriodSchema>) {
    const period = this.period(raw),
      now = this.now();
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new FinancialAlertService(db, this.now);
      const candidates = await service.candidates(userId, period);
      const existing = await db
        .select()
        .from(financialAlerts)
        .where(
          and(
            eq(financialAlerts.userId, userId),
            eq(financialAlerts.month, period.month),
            eq(financialAlerts.year, period.year),
          ),
        );
      const seen = new Set<string>();
      for (const candidate of candidates.items) {
        const key = JSON.stringify([candidate.rule, candidate.entityKey]);
        if (seen.has(key)) continue;
        seen.add(key);
        const contentHash = hash({ ruleVersion: 1, ...candidate });
        const old = existing.find(
          (r) => r.rule === candidate.rule && r.entityKey === candidate.entityKey,
        );
        if (old?.contentHash === contentHash && old.active) continue;
        if (old) {
          const [updated] = await db
            .update(financialAlerts)
            .set({
              evidence: candidate.evidence,
              contentHash,
              revision: old.revision + 1,
              active: true,
              state: old.mutedAt ? 'muted' : 'open',
              readAt: null,
              resolvedAt: null,
            })
            .where(and(eq(financialAlerts.userId, userId), eq(financialAlerts.id, old.id)))
            .returning();
          await new AuditService(db).log(
            userId,
            'refresh',
            'financial_alert',
            old.id,
            old,
            updated,
          );
        } else {
          const [created] = await db
            .insert(financialAlerts)
            .values({ ...candidate, ...period, userId, contentHash })
            .returning();
          await new AuditService(db).log(
            userId,
            'create',
            'financial_alert',
            created.id,
            null,
            created,
          );
        }
      }
      for (const old of existing) {
        if (
          !candidates.complete ||
          !old.active ||
          seen.has(JSON.stringify([old.rule, old.entityKey]))
        )
          continue;
        const [updated] = await db
          .update(financialAlerts)
          .set({ active: false, state: 'resolved', resolvedAt: now, revision: old.revision + 1 })
          .where(and(eq(financialAlerts.userId, userId), eq(financialAlerts.id, old.id)))
          .returning();
        await new AuditService(db).log(userId, 'resolve', 'financial_alert', old.id, old, updated);
      }
      return service.list(userId, period);
    });
  }
  private async candidates(userId: string, period: { month: number; year: number }) {
    const { month, year } = period,
      today = settlementDateKey(this.now());
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const start = new Date(Date.UTC(year, month - 7, 1)).toISOString().slice(0, 10);
    const [budget, cards, bills, imports, observations, readiness, forecast] = await Promise.all([
      new BudgetService(this.db, this.now).list(userId, period),
      this.db
        .select({ id: accounts.id, name: accounts.name, closingDay: creditCardConfigs.closingDay })
        .from(accounts)
        .innerJoin(creditCardConfigs, eq(creditCardConfigs.accountId, accounts.id))
        .where(and(eq(accounts.userId, userId), eq(accounts.isActive, true))),
      this.db
        .select({ bill: creditCardBills })
        .from(creditCardBills)
        .innerJoin(
          accounts,
          and(eq(accounts.id, creditCardBills.creditCardAccountId), eq(accounts.userId, userId)),
        )
        .where(and(eq(creditCardBills.month, month), eq(creditCardBills.year, year))),
      this.db
        .select()
        .from(faturaImports)
        .where(
          and(
            eq(faturaImports.userId, userId),
            eq(faturaImports.billingMonth, month),
            eq(faturaImports.billingYear, year),
          ),
        )
        .orderBy(desc(faturaImports.createdAt), faturaImports.id)
        .limit(501),
      this.db
        .select()
        .from(purchaseObservations)
        .where(
          and(
            eq(purchaseObservations.userId, userId),
            isNull(purchaseObservations.mergedIntoId),
            ne(purchaseObservations.review, 'ignored'),
            ne(purchaseObservations.confirmation, 'retracted'),
            sql`(${purchaseObservations.purchaseDate} IS NULL OR ${purchaseObservations.purchaseDate} BETWEEN ${start}::date AND ${end}::date)`,
          ),
        )
        .orderBy(desc(purchaseObservations.purchaseDate), purchaseObservations.id)
        .limit(1001),
      new CashReadinessService(this.db).get(userId, this.now()),
      new ForecastContextService(this.db).getMonths(userId, period, 1, this.now()),
    ]);
    const result: Candidate[] = [];
    for (const card of cards) {
      const statement = imports.find(
        (i) =>
          i.cardAccountId === card.id || i.itemsJson.cardAccounts.some((c) => c.id === card.id),
      );
      const bill = bills.find((b) => b.bill.creditCardAccountId === card.id)?.bill;
      const closing =
        bill?.closingDate ??
        `${key}-${String(Math.min(card.closingDay, Number(end.slice(8)))).padStart(2, '0')}`;
      if (statement?.itemsJson.reconciliation?.status === 'difference')
        result.push({
          rule: 'reconciliation_difference',
          entityKey: card.id,
          evidence: {
            label: card.name,
            amount:
              statement.itemsJson.reconciliation.documentDelta ??
              statement.itemsJson.reconciliation.compositionDelta ??
              undefined,
            basis: 'statement_comparison',
          },
        });
      else if (
        closing < today &&
        !(
          statement?.status === 'applied' &&
          statement.periodConfidence === 'confirmed' &&
          statement.itemsJson.reconciliation?.status === 'reconciled' &&
          !statement.itemsJson.reconciliation.estimated &&
          !statement.itemsJson.reconciliation.future
        )
      )
        result.push({
          rule: 'stale_statement',
          entityKey: card.id,
          evidence: {
            label: card.name,
            basis: bill?.closingDate ? 'statement_cycle' : 'estimated_cycle',
          },
        });
    }
    for (const observation of observations.slice(0, 1000)) {
      if (
        observation.unrecognized &&
        (!observation.purchaseDate || observation.purchaseDate.startsWith(key))
      )
        result.push({
          rule: 'unrecognized_purchase',
          entityKey: observation.id,
          evidence: {
            label: observation.description,
            amount: observation.currency === 'BRL' ? observation.amount : undefined,
            basis: `observation:${observation.version}`,
          },
        });
    }
    for (const item of budget.items) {
      if (item.progress.nearLimit)
        result.push({
          rule: item.progress.exceeded ? 'budget_exceeded' : 'budget_near',
          entityKey: item.id,
          evidence: {
            label: item.economicScope,
            amount: item.progress.projected,
            limit: item.limitAmount,
            basis: 'expense_competence',
          },
        });
    }
    const recurring = recurringCandidates(
      observations.slice(0, 1000).flatMap((o) =>
        o.cardAccountId &&
        o.purchaseDate &&
        o.kind === 'purchase' &&
        (o.totalInstallments ?? 1) === 1
          ? [
              {
                id: o.id,
                date: o.purchaseDate,
                amount: o.amount,
                currency: o.currency,
                description: o.description,
                cardAccountId: o.cardAccountId,
                actual: o.confirmation === 'posted' || o.review === 'accepted',
              },
            ]
          : [],
      ),
      today,
    );
    for (const candidate of recurring) {
      if (!candidate.sampleDates[candidate.sampleDates.length - 1].startsWith(key)) continue;
      result.push({
        rule: candidate.priceChanged ? 'recurring_price' : 'recurring_candidate',
        entityKey: hash([candidate.cardAccountId, candidate.merchant]),
        evidence: {
          label: candidate.merchant,
          amount: candidate.latestAmount,
          previousAmount: candidate.previousAmount,
          count: candidate.count,
          sampleDates: candidate.sampleDates,
          sampleIds: candidate.sampleIds,
          toleranceAmount: candidate.toleranceAmount,
          basis: 'monthly_25_35_days',
        },
      });
    }
    if (
      !readiness.ready ||
      !budget.summary.reliable ||
      forecast[0].incomeUnavailableCount > 0 ||
      forecast[0].payrollDateUncertain ||
      observations.length > 1000 ||
      imports.length > 500
    ) {
      result.push({
        rule: 'cash_coverage',
        entityKey: 'coverage',
        evidence: {
          label: 'coverage',
          reason: [
            ...readiness.reasons,
            ...(!budget.summary.reliable ? ['expense_coverage'] : []),
            ...(forecast[0].incomeUnavailableCount > 0 || forecast[0].payrollDateUncertain
              ? ['income_coverage']
              : []),
            ...(observations.length > 1000 || imports.length > 500 ? ['bounded_scan'] : []),
          ].join(','),
          basis: 'review_required',
        },
      });
    } else if (key === today.slice(0, 7)) {
      const [core] = await new BalanceProjectionService(this.db).getBaselineCores(userId, {
        horizon: 1,
        asOf: new Date(`${today}T12:00:00-03:00`),
      });
      const projected = Money.fromNumber(readiness.cash.totalCash, 'BRL').add(
        Money.fromNumber(core.net, 'BRL'),
      );
      if (projected.isNegative())
        result.push({
          rule: 'projected_commitment',
          entityKey: 'month',
          evidence: {
            label: key,
            amount: projected.toDbString(),
            basis: 'registered_obligations_and_expected_receipts',
          },
        });
    }
    return { items: result, complete: observations.length <= 1000 && imports.length <= 500 };
  }
}
