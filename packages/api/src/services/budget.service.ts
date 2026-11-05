import type { DbExecutor } from '@fc/db';
import {
  accounts,
  budgets,
  categories,
  creditCardConfigs,
  purchaseLedgerLinks,
  purchaseObservations,
  transactions,
} from '@fc/db';
import { assignBillingPeriod, type BudgetExpense, budgetProgress, Money } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { expensePeriodScope } from '../lib/expense-period.ts';
import { AuditService } from './audit.service.ts';
import { DataCoverageService } from './data-coverage.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';

export const budgetPeriodSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2200),
});
const limitSchema = z
  .string()
  .regex(/^\d{1,10}\.\d{2}$/)
  .refine((v) => Money.fromString(v, 'BRL').isPositive());
export const budgetCreateSchema = budgetPeriodSchema.extend({
  currency: z.literal('BRL').default('BRL'),
  categoryId: z.guid().nullable().default(null),
  economicScope: z.enum(['all', 'own', 'family', 'work', 'property']).default('all'),
  limitAmount: limitSchema,
});
export const budgetUpdateSchema = z.object({
  id: z.guid(),
  version: z.number().int().positive(),
  limitAmount: limitSchema,
});

export class BudgetService {
  constructor(
    private db: DbExecutor,
    private now: () => Date = () => new Date(),
  ) {}
  async create(userId: string, raw: z.input<typeof budgetCreateSchema>) {
    const input = budgetCreateSchema.parse(raw);
    if (input.categoryId) {
      const [category] = await this.db
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.userId, userId),
            eq(categories.id, input.categoryId),
            eq(categories.type, 'expense'),
          ),
        );
      if (!category)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Expense category not found' });
    }
    const [row] = await this.db
      .insert(budgets)
      .values({ ...input, userId })
      .onConflictDoNothing()
      .returning();
    if (!row)
      throw new TRPCError({ code: 'CONFLICT', message: 'Budget already exists for this scope' });
    await new AuditService(this.db).log(userId, 'create', 'budget', row.id, null, row);
    return row;
  }
  async update(userId: string, raw: z.input<typeof budgetUpdateSchema>) {
    const input = budgetUpdateSchema.parse(raw);
    const [row] = await this.db
      .update(budgets)
      .set({ limitAmount: input.limitAmount, version: input.version + 1 })
      .where(
        and(
          eq(budgets.userId, userId),
          eq(budgets.id, input.id),
          eq(budgets.version, input.version),
        ),
      )
      .returning();
    if (!row)
      throw new TRPCError({ code: 'CONFLICT', message: 'Budget changed; reload before editing' });
    await new AuditService(this.db).log(
      userId,
      'update',
      'budget',
      row.id,
      { version: input.version },
      row,
    );
    return row;
  }
  async list(userId: string, raw: z.input<typeof budgetPeriodSchema>) {
    const { month, year } = budgetPeriodSchema.parse(raw);
    const now = this.now();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const [limits, rows, observations, configs, coverage, receivables] = await Promise.all([
      this.db
        .select()
        .from(budgets)
        .where(and(eq(budgets.userId, userId), eq(budgets.month, month), eq(budgets.year, year)))
        .orderBy(budgets.createdAt, budgets.id),
      this.db
        .select()
        .from(transactions)
        .where(expensePeriodScope(userId, month, year)),
      this.db
        .select()
        .from(purchaseObservations)
        .where(
          and(
            eq(purchaseObservations.userId, userId),
            isNull(purchaseObservations.mergedIntoId),
            ne(purchaseObservations.review, 'ignored'),
            ne(purchaseObservations.confirmation, 'retracted'),
            sql`NOT EXISTS (SELECT 1 FROM ${purchaseLedgerLinks} l WHERE l.user_id=${userId} AND l.observation_id=${purchaseObservations.id} AND l.revoked_at IS NULL)`,
          ),
        )
        .orderBy(desc(purchaseObservations.createdAt), purchaseObservations.id)
        .limit(1001),
      this.db
        .select({ cardId: accounts.id, closingDay: creditCardConfigs.closingDay })
        .from(accounts)
        .innerJoin(creditCardConfigs, eq(creditCardConfigs.accountId, accounts.id))
        .where(eq(accounts.userId, userId)),
      new DataCoverageService(this.db, this.now).get(userId),
      new FamilyLoanFlowService(this.db).listWithTotals(userId, month, year),
    ]);
    const expenses: BudgetExpense[] = rows.map((row) => ({
      amount: row.amount,
      currency: row.currency,
      categoryId: row.categoryId,
      responsibility: row.economicResponsibility,
      phase:
        row.date.toISOString().slice(0, 10) > today ||
        ((row.scheduledTransactionId !== null ||
          ['loan_payment', 'loan_insurance', 'recurring_bill'].includes(row.domainType ?? '')) &&
          (!row.isPaid || row.settlementSource === 'date_assumed') &&
          row.postedDateSource !== 'institution')
          ? 'committed'
          : 'confirmed',
      refund: row.domainType === 'credit_card_refund',
      reviewed: row.classificationReviewedAt !== null,
    }));
    let estimatedCount = 0,
      unallocatedCount = 0;
    for (const row of observations.slice(0, 1000)) {
      const config = configs.find((c) => c.cardId === row.cardAccountId);
      if (!row.purchaseDate || !config) {
        unallocatedCount++;
        continue;
      }
      const [y, m, d] = row.purchaseDate.split('-').map(Number);
      const period = assignBillingPeriod(new Date(y, m - 1, d), config.closingDay);
      if (period.billingMonth !== month || period.billingYear !== year) continue;
      if (
        row.amountMeaning === 'unknown' ||
        (row.amountMeaning === 'purchase_total' && (row.totalInstallments ?? 1) > 1)
      ) {
        unallocatedCount++;
        continue;
      }
      estimatedCount++;
      expenses.push({
        amount: row.amount,
        currency: row.currency,
        categoryId: row.categoryId,
        responsibility: 'unknown',
        phase: 'provisional',
        refund: row.kind === 'refund',
        reviewed: false,
      });
    }
    const sourcesReconciled =
      unallocatedCount === 0 &&
      estimatedCount === 0 &&
      observations.length <= 1000 &&
      coverage.every((card) => {
        const cycle = card.lastReconciledCycle;
        return (
          card.pending === 0 &&
          cycle?.month === month &&
          cycle.year === year &&
          cycle.confidence === 'confirmed' &&
          cycle.estimated === false &&
          cycle.future === false &&
          !card.sources.some((source) => source.active && source.error)
        );
      });
    return {
      basis: 'expense_competence' as const,
      asOf: now,
      month,
      year,
      currency: 'BRL' as const,
      items: limits.map((limit) => ({
        ...limit,
        progress: budgetProgress(
          limit.limitAmount,
          limit.categoryId,
          limit.economicScope,
          expenses,
          sourcesReconciled,
        ),
      })),
      summary: budgetProgress('0.00', null, 'all', expenses, sourcesReconciled),
      receivableOutstanding: Money.sum(
        receivables.map((r) => Money.fromString(String(r.outstanding), 'BRL')),
      ).toDbString(),
      provisional: { estimatedCount, unallocatedCount, truncated: observations.length > 1000 },
      coverage,
    };
  }
}
