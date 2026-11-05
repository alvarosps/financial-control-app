import { createHash } from 'node:crypto';
import type { DbExecutor } from '@fc/db';
import {
  accounts,
  creditCardBills,
  creditCardConfigs,
  faturaImports,
  loanConfigs,
  payrollDeductions,
  purchaseLedgerLinks,
  purchaseObservations,
  transactions,
} from '@fc/db';
import { assignBillingPeriod, Money } from '@fc/domain';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { cashMovementDay } from '../lib/cash-selection.ts';
import { BankReconciliationService } from './bank-reconciliation.service.ts';
import { CashReadinessService } from './cash-readiness.service.ts';
import { ClassificationService } from './classification.service.ts';
import { ForecastContextService } from './forecast-context.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';

const money = z.string().regex(/^-?\d{1,10}\.\d{2}$/);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
export const closingReviewSchema = z
  .object({
    wallets: z
      .array(
        z.object({
          accountId: z.guid(),
          amount: money,
          source: z.string().trim().min(3).max(200),
        }),
      )
      .max(100)
      .default([]),
    cards: z
      .array(
        z.object({
          accountId: z.guid(),
          totalAmount: money,
          closingDate: day,
          dueDate: day,
          source: z.string().trim().min(3).max(200),
        }),
      )
      .max(100)
      .default([]),
    waivers: z.record(z.string(), z.string().trim().min(3).max(500)).default({}),
    reviewHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine(
    (v) =>
      new Set(v.wallets.map((w) => w.accountId)).size === v.wallets.length &&
      new Set(v.cards.map((c) => c.accountId)).size === v.cards.length,
    'Duplicate evidence',
  );
export type ClosingReview = z.input<typeof closingReviewSchema>;
export type ClosingCheck = {
  key: string;
  kind:
    | 'period'
    | 'wallet'
    | 'card'
    | 'inbox'
    | 'income'
    | 'receivables'
    | 'payroll'
    | 'classification';
  severity: 'ok' | 'warning' | 'critical';
  code: string;
  count?: number;
  name?: string;
  expected?: string;
  actual?: string;
};

export class MonthClosingChecklistService {
  constructor(
    private db: DbExecutor,
    private now: () => Date = () => new Date(),
  ) {}
  async preview(userId: string, month: number, year: number, raw: ClosingReview = {}) {
    z.object({
      month: z.number().int().min(1).max(12),
      year: z.number().int().min(2000).max(2200),
    }).parse({ month, year });
    const review = closingReviewSchema.parse(raw);
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const start = `${key}-01`;
    const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const asOf = new Date(`${end}T23:59:59.999-03:00`);
    const [
      rows,
      allAccounts,
      cash,
      classification,
      summary,
      forecast,
      imports,
      bills,
      observations,
      bankEvidence,
      cardConfigs,
      pendingPayroll,
      walletMovements,
    ] = await Promise.all([
      this.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.isReversed, false),
            isNull(transactions.reversesTransactionId),
            sql`CASE WHEN ${transactions.domainType}::text LIKE 'credit_card_%' AND ${transactions.billingMonth} IS NOT NULL THEN ${transactions.billingMonth}=${month} AND ${transactions.billingYear}=${year} ELSE ${transactions.date} BETWEEN ${start}::date AND ${end}::date END`,
          ),
        )
        .orderBy(transactions.id),
      this.db.select().from(accounts).where(eq(accounts.userId, userId)).orderBy(accounts.id),
      new CashReadinessService(this.db).get(userId, asOf),
      new ClassificationService(this.db).preview(userId, { month, year }),
      new MonthSummaryService(this.db).getSummary(userId, month, year),
      new ForecastContextService(this.db).getMonths(userId, { month, year }, 1, asOf),
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
        .orderBy(desc(faturaImports.createdAt), desc(faturaImports.id)),
      this.db
        .select({ bill: creditCardBills })
        .from(creditCardBills)
        .innerJoin(
          accounts,
          and(eq(accounts.id, creditCardBills.creditCardAccountId), eq(accounts.userId, userId)),
        )
        .where(and(eq(creditCardBills.month, month), eq(creditCardBills.year, year)))
        .orderBy(creditCardBills.id),
      this.db
        .select()
        .from(purchaseObservations)
        .where(
          and(
            eq(purchaseObservations.userId, userId),
            isNull(purchaseObservations.mergedIntoId),
            sql`(${purchaseObservations.confirmation} <> 'retracted' OR ${purchaseObservations.review}='needs_review') AND ${purchaseObservations.review} <> 'ignored'`,
            sql`(${purchaseObservations.purchaseDate} <= ${end}::date OR ${purchaseObservations.postedDate} <= ${end}::date OR (${purchaseObservations.purchaseDate} IS NULL AND ${purchaseObservations.postedDate} IS NULL))`,
            sql`(${purchaseObservations.review}='needs_review' OR NOT EXISTS (SELECT 1 FROM ${purchaseLedgerLinks} l WHERE l.user_id=${userId} AND l.observation_id=${purchaseObservations.id} AND l.revoked_at IS NULL))`,
          ),
        )
        .orderBy(purchaseObservations.id)
        .limit(1001),
      new BankReconciliationService(this.db).closingEvidence(userId, start, end),
      this.db
        .select({ accountId: accounts.id, closingDay: creditCardConfigs.closingDay })
        .from(accounts)
        .innerJoin(
          creditCardConfigs,
          eq(
            creditCardConfigs.accountId,
            sql`coalesce(${accounts.parentAccountId},${accounts.id})`,
          ),
        )
        .where(eq(accounts.userId, userId))
        .orderBy(accounts.id),
      this.db
        .select({ id: transactions.id })
        .from(transactions)
        .innerJoin(loanConfigs, eq(loanConfigs.accountId, transactions.destinationAccountId))
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.domainType, 'loan_payment'),
            eq(transactions.isReversed, false),
            isNull(transactions.reversesTransactionId),
            eq(loanConfigs.paymentMethod, 'payroll'),
            sql`${transactions.date} BETWEEN ${start}::date AND ${end}::date`,
            sql`(${transactions.isPaid}=false OR ${transactions.settlementSource}<>'payroll' OR NOT EXISTS (SELECT 1 FROM ${payrollDeductions} d WHERE d.user_id=${userId} AND d.loan_transaction_id=${transactions.id} AND d.reversed_at IS NULL))`,
          ),
        )
        .orderBy(transactions.id),
      this.db
        .select({
          id: transactions.id,
          sourceAccountId: transactions.sourceAccountId,
          destinationAccountId: transactions.destinationAccountId,
          day: cashMovementDay,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.isPaid, true),
            eq(transactions.isReversed, false),
            isNull(transactions.reversesTransactionId),
            sql`${cashMovementDay} BETWEEN ${start}::date AND ${end}::date`,
          ),
        )
        .orderBy(transactions.id),
    ]);
    const items: ClosingCheck[] = [];
    items.push({
      key: 'period',
      kind: 'period',
      severity: asOf >= this.now() ? 'critical' : 'ok',
      code: asOf >= this.now() ? 'unfinished_period' : 'period_complete',
    });
    const walletAccounts = allAccounts.filter((a) => a.type === 'checking' && a.isActive);
    for (const wallet of allAccounts.filter(
      (a) =>
        a.type === 'checking' &&
        !a.isActive &&
        [...rows, ...walletMovements].some(
          (r) => r.sourceAccountId === a.id || r.destinationAccountId === a.id,
        ),
    )) {
      items.push({
        key: `inactive_wallet:${wallet.id}`,
        kind: 'wallet',
        name: wallet.name,
        severity: 'critical',
        code: 'inactive_wallet_movements',
      });
    }
    const bankPending = bankEvidence.items.filter((row) => row.state !== 'linked');
    const bankCritical =
      bankEvidence.truncated ||
      bankPending.some((row) => row.state === 'needs_review' || row.movement.status === 'POSTED');
    items.push({
      key: 'bank_movements',
      kind: 'wallet',
      severity: bankCritical ? 'critical' : bankPending.length ? 'warning' : 'ok',
      code: bankCritical
        ? 'bank_difference'
        : bankPending.length
          ? 'bank_provisional'
          : 'bank_reconciled',
      count: bankPending.length,
    });
    if (!walletAccounts.length)
      items.push({ key: 'wallets', kind: 'wallet', severity: 'warning', code: 'no_wallet' });
    if (cash.reasons.some((reason) => reason !== 'no_wallet'))
      items.push({
        key: 'cash_basis',
        kind: 'wallet',
        severity: 'critical',
        code: 'unreconciled_cash',
      });
    for (const wallet of walletAccounts) {
      const expected = Money.fromNumber(
        cash.cash.wallets.find((w) => w.id === wallet.id)?.cash ?? 0,
        'BRL',
      ).toDbString();
      const proof = review.wallets.find((w) => w.accountId === wallet.id);
      const matched = !!proof && proof.amount === expected;
      items.push({
        key: `wallet:${wallet.id}`,
        kind: 'wallet',
        name: wallet.name,
        severity: matched ? 'ok' : 'critical',
        code: !proof
          ? 'wallet_evidence_missing'
          : matched
            ? 'wallet_reconciled'
            : 'wallet_difference',
        expected,
        actual: proof?.amount,
      });
    }
    if (review.wallets.some((w) => !walletAccounts.some((a) => a.id === w.accountId)))
      items.push({
        key: 'wallet_owner',
        kind: 'wallet',
        severity: 'critical',
        code: 'foreign_evidence',
      });
    const cards = allAccounts.filter(
      (a) =>
        a.type === 'credit_card' &&
        !a.parentAccountId &&
        (a.isActive ||
          rows.some(
            (r) =>
              r.destinationAccountId === a.id ||
              allAccounts.some(
                (child) => child.parentAccountId === a.id && child.id === r.destinationAccountId,
              ),
          )),
    );
    for (const card of cards) {
      const ids = new Set(
        allAccounts
          .filter((a) => a.id === card.id || a.parentAccountId === card.id)
          .map((a) => a.id),
      );
      const cardRows = rows.filter(
        (r) => ids.has(r.destinationAccountId) && r.domainType?.startsWith('credit_card_'),
      );
      const expected = Money.sum(
        cardRows.map((r) =>
          Money.fromString(r.amount, 'BRL').multiply(
            r.domainType === 'credit_card_refund' ? -1 : 1,
          ),
        ),
        'BRL',
      ).toDbString();
      const proof = review.cards.find((c) => c.accountId === card.id);
      const latestByCard = new Map(
        [...ids].map((id) => [
          id,
          imports
            .filter(
              (i) =>
                i.status !== 'discarded' &&
                (i.cardAccountId === id || i.itemsJson.cardAccounts.some((c) => c.id === id)),
            )
            .sort(
              (a, b) =>
                (b.appliedAt ?? b.createdAt).getTime() - (a.appliedAt ?? a.createdAt).getTime() ||
                Number(b.itemsJson.reconciliation?.status === 'difference') -
                  Number(a.itemsJson.reconciliation?.status === 'difference') ||
                Number(b.cardAccountId === id) - Number(a.cardAccountId === id) ||
                b.id.localeCompare(a.id),
            )[0],
        ]),
      );
      const latestImports = [...new Set([...latestByCard.values()].filter((i) => i !== undefined))];
      const knownDifference = latestImports.some(
        (i) => i.itemsJson.reconciliation?.status === 'difference',
      );
      const requiredIds = new Set([card.id, ...cardRows.map((r) => r.destinationAccountId)]);
      const imported = [...requiredIds].every((id) => {
        const evidence = latestByCard.get(id);
        if (
          !evidence ||
          evidence.status !== 'applied' ||
          evidence.periodConfidence !== 'confirmed' ||
          evidence.itemsJson.reconciliation?.status !== 'reconciled' ||
          evidence.itemsJson.reconciliation.estimated ||
          evidence.itemsJson.reconciliation.future
        )
          return false;
        const coveredIds = new Set([
          evidence.cardAccountId,
          ...evidence.itemsJson.cardAccounts.map((c) => c.id),
        ]);
        if ([...coveredIds].some((covered) => !ids.has(covered))) return false;
        const coveredTotal = Money.sum(
          cardRows
            .filter((r) => coveredIds.has(r.destinationAccountId))
            .map((r) =>
              Money.fromString(r.amount, 'BRL').multiply(
                r.domainType === 'credit_card_refund' ? -1 : 1,
              ),
            ),
          'BRL',
        ).toDbString();
        // Stored bill totals may be per-card or consolidated after payment; the document defines its own scope.
        const bill =
          bills.find((b) => b.bill.creditCardAccountId === id)?.bill ??
          bills.find((b) => b.bill.creditCardAccountId === card.id)?.bill;
        return (
          evidence.statedTotal === coveredTotal &&
          !!bill &&
          !!bill.closingDate &&
          bill.closingDate.slice(0, 7) === key &&
          !!bill.dueDate &&
          bill.dueDate >= bill.closingDate &&
          bill.closingDate === evidence.closingDate &&
          bill.dueDate === evidence.dueDate &&
          ['institution', 'user'].includes(bill.closingDateSource) &&
          ['institution', 'user'].includes(bill.dueDateSource)
        );
      });
      const proofDates =
        !!proof && proof.closingDate.slice(0, 7) === key && proof.dueDate >= proof.closingDate;
      const manualMatched = !!proof && proof.totalAmount === expected && proofDates;
      const reconciled = manualMatched || imported;
      const badCurrency = cardRows.some((r) => r.currency !== 'BRL');
      items.push({
        key: `card:${card.id}`,
        kind: 'card',
        name: card.name,
        expected,
        actual: proof?.totalAmount,
        severity: knownDifference || badCurrency || !reconciled ? 'critical' : 'ok',
        code: knownDifference
          ? 'card_difference'
          : badCurrency
            ? 'unsupported_currency'
            : proof && !proofDates
              ? 'card_period_unknown'
              : proof && proof.totalAmount !== expected
                ? 'card_difference'
                : reconciled
                  ? 'card_reconciled'
                  : 'card_evidence_missing',
      });
    }
    if (review.cards.some((c) => !cards.some((a) => a.id === c.accountId)))
      items.push({
        key: 'card_owner',
        kind: 'card',
        severity: 'critical',
        code: 'foreign_evidence',
      });
    if (
      rows.some(
        (r) => r.domainType?.startsWith('credit_card_') && (!r.billingMonth || !r.billingYear),
      )
    )
      items.push({
        key: 'unknown_period',
        kind: 'period',
        severity: 'critical',
        code: 'card_period_unknown',
      });
    const relevantObservations = observations.filter((o) => {
      if (o.review === 'needs_review') return true;
      const config = cardConfigs.find((c) => c.accountId === o.cardAccountId);
      if (!config || !o.purchaseDate) return true;
      const [y, m, d] = o.purchaseDate.split('-').map(Number);
      const period = assignBillingPeriod(new Date(y, m - 1, d), config.closingDay);
      return period.billingMonth === month && period.billingYear === year;
    });
    const confirmedPending = relevantObservations.filter(
      (o) =>
        o.unrecognized ||
        o.confirmation === 'posted' ||
        o.review === 'needs_review' ||
        !o.purchaseDate ||
        !cardConfigs.some((c) => c.accountId === o.cardAccountId),
    );
    items.push({
      key: 'inbox',
      kind: 'inbox',
      severity:
        observations.length > 1000 || confirmedPending.length
          ? 'critical'
          : relevantObservations.length
            ? 'warning'
            : 'ok',
      code:
        observations.length > 1000
          ? 'inbox_overflow'
          : confirmedPending.length
            ? 'inbox_difference'
            : relevantObservations.length
              ? 'inbox_provisional'
              : 'inbox_clear',
      count: relevantObservations.length,
    });
    const sources = forecast[0].sources;
    const estimatedIncome = sources
      .flatMap((s) => s.occurrences)
      .filter((o) => !o.cashConfirmed).length;
    items.push({
      key: 'income',
      kind: 'income',
      severity: summary.incomeUnavailableCount ? 'critical' : estimatedIncome ? 'warning' : 'ok',
      code: summary.incomeUnavailableCount
        ? 'income_fx_missing'
        : estimatedIncome
          ? 'income_estimated'
          : 'income_confirmed',
      count: estimatedIncome,
    });
    items.push({
      key: 'payroll',
      kind: 'payroll',
      severity:
        pendingPayroll.length || sources.some((s) => s.needsPayrollAllocation) ? 'critical' : 'ok',
      code:
        pendingPayroll.length || sources.some((s) => s.needsPayrollAllocation)
          ? 'payroll_unallocated'
          : 'payroll_reconciled',
      count: pendingPayroll.length,
    });
    items.push({
      key: 'receivables',
      kind: 'receivables',
      severity: forecast[0].familyRemaining > 0 ? 'warning' : 'ok',
      code: forecast[0].familyRemaining > 0 ? 'receivables_pending' : 'receivables_allocated',
      expected: Money.fromNumber(forecast[0].familyRemaining, 'BRL').toDbString(),
    });
    const coverage = classification.coverage;
    const enough =
      Money.fromString(coverage.totalAmount, 'BRL').isZero() ||
      Money.fromString(coverage.reviewedAmount, 'BRL')
        .toDecimal()
        .div(coverage.totalAmount)
        .gte('0.9');
    items.push({
      key: 'classification',
      kind: 'classification',
      severity: coverage.unsupportedCurrencyCount
        ? 'critical'
        : enough && !coverage.unknownResponsibilityCount
          ? 'ok'
          : 'warning',
      code: coverage.unsupportedCurrencyCount
        ? 'unsupported_currency'
        : !enough
          ? 'classification_low'
          : coverage.unknownResponsibilityCount
            ? 'responsibility_unknown'
            : 'classification_reviewed',
      count: coverage.count - coverage.reviewedCount,
    });
    const origins = new Map<
      string,
      {
        origin: string;
        currency: string;
        amount: Money;
        confirmedCount: number;
        predictedCount: number;
      }
    >();
    for (const row of rows.filter((r) => r.domainType !== 'bill_payment')) {
      const origin = row.domainType ?? row.type;
      const mapKey = `${origin}:${row.currency}`;
      const entry = origins.get(mapKey) ?? {
        origin,
        currency: row.currency,
        amount: Money.zero(row.currency),
        confirmedCount: 0,
        predictedCount: 0,
      };
      entry.amount = entry.amount.add(
        Money.fromString(row.amount, row.currency).multiply(
          row.domainType === 'credit_card_refund' ? -1 : 1,
        ),
      );
      if (row.isPaid && ['manual', 'bank', 'payroll'].includes(row.settlementSource))
        entry.confirmedCount++;
      else entry.predictedCount++;
      origins.set(mapKey, entry);
    }
    const totalsByOrigin = [...origins.values()]
      .map((o) => ({ ...o, amount: o.amount.toDbString() }))
      .sort((a, b) => `${a.origin}:${a.currency}`.localeCompare(`${b.origin}:${b.currency}`));
    const evidence = {
      wallets: [...review.wallets].sort((a, b) => a.accountId.localeCompare(b.accountId)),
      cards: [...review.cards].sort((a, b) => a.accountId.localeCompare(b.accountId)),
    };
    const basis = {
      ruleVersion: 1,
      basis: 'expense_competence' as const,
      month,
      year,
      periodEnd: asOf.toISOString(),
      summary,
      totals: {
        income: Money.fromNumber(summary.totalIncome, 'BRL').toDbString(),
        expenses: Money.fromNumber(summary.totalExpenses, 'BRL').toDbString(),
        balance: Money.fromNumber(summary.balance, 'BRL').toDbString(),
      },
      totalsByOrigin,
      items,
      classification: coverage,
      cash: {
        ...cash,
        cash: {
          ...cash.cash,
          wallets: [...cash.cash.wallets].sort((a, b) => a.id.localeCompare(b.id)),
        },
      },
      income: sources,
      bankEvidence,
      receivables: {
        owed: forecast[0].familyOwed,
        allocated: forecast[0].familyAllocated,
        pending: forecast[0].familyRemaining,
      },
      evidence,
    };
    const reviewHash = createHash('sha256')
      .update(
        JSON.stringify({
          basis,
          rows,
          allAccounts,
          observations,
          imports,
          bills,
          cardConfigs,
          walletMovements,
        }),
      )
      .digest('hex');
    return { ...basis, reviewHash };
  }
}
