import { createHash } from 'node:crypto';
import type { ClassificationState, DbExecutor } from '@fc/db';
import {
  accounts,
  categories,
  classificationBatches,
  classificationRules,
  transactions,
} from '@fc/db';
import { Money, normalizeMerchant, suggestMerchantClassification } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { expensePeriodScope, transactionPeriodDates } from '../lib/expense-period.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { assertOpenSettlementPeriods } from '../lib/settlement-guards.ts';
import { AuditService } from './audit.service.ts';

export const classificationPeriodSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2200),
  cursor: z.guid().optional(),
});
export const classificationRuleSchema = z.object({
  merchant: z.string().trim().min(1).max(500),
  categoryId: z.guid(),
  cardAccountId: z.guid().nullable().optional(),
  priority: z.number().int().min(0).max(1000).default(0),
});
export const classificationApplySchema = z
  .object({
    items: z
      .array(z.object({ id: z.guid(), version: z.string().regex(/^[a-f0-9]{64}$/) }))
      .min(1)
      .max(100),
    categoryId: z.guid().nullable().optional(),
    ruleId: z.guid().optional(),
    ruleVersion: z.number().int().positive().optional(),
    economicResponsibility: z.enum(['unknown', 'own', 'family', 'work', 'property']).optional(),
    receivableAccountId: z.guid().nullable().optional(),
  })
  .refine(
    (v) =>
      new Set(v.items.map((i) => i.id)).size === v.items.length &&
      (v.ruleId
        ? v.ruleVersion !== undefined && v.categoryId === undefined
        : v.ruleVersion === undefined) &&
      (v.ruleId !== undefined ||
        v.categoryId !== undefined ||
        v.economicResponsibility !== undefined ||
        v.receivableAccountId !== undefined),
    'Invalid review',
  );
export const classificationUndoSchema = z.object({
  batchId: z.guid(),
  reason: z.string().trim().min(3).max(1000),
});
type Row = typeof transactions.$inferSelect;
function version(row: Row) {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}
function state(row: Row): ClassificationState {
  return {
    categoryId: row.categoryId,
    classificationSource: row.classificationSource,
    classificationRuleId: row.classificationRuleId,
    classificationRuleVersion: row.classificationRuleVersion,
    classificationConfidence: row.classificationConfidence,
    classificationReviewedAt: row.classificationReviewedAt?.toISOString() ?? null,
    economicResponsibility: row.economicResponsibility,
    receivableAccountId: row.receivableAccountId,
  };
}

export class ClassificationService {
  constructor(private db: DbExecutor) {}

  async rules(userId: string) {
    return this.db
      .select()
      .from(classificationRules)
      .where(eq(classificationRules.userId, userId))
      .orderBy(desc(classificationRules.priority), classificationRules.id);
  }
  async history(userId: string) {
    return this.db
      .select({
        id: classificationBatches.id,
        createdAt: classificationBatches.createdAt,
        undoneAt: classificationBatches.undoneAt,
        undoReason: classificationBatches.undoReason,
        count: sql<number>`jsonb_array_length(${classificationBatches.items})`,
      })
      .from(classificationBatches)
      .where(eq(classificationBatches.userId, userId))
      .orderBy(desc(classificationBatches.createdAt))
      .limit(20);
  }
  private async category(userId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(categories)
      .where(
        and(eq(categories.userId, userId), eq(categories.id, id), eq(categories.type, 'expense')),
      );
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Expense category not found' });
  }
  async createRule(userId: string, raw: z.input<typeof classificationRuleSchema>) {
    const input = classificationRuleSchema.parse(raw);
    await this.category(userId, input.categoryId);
    if (input.cardAccountId) {
      const [card] = await this.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, input.cardAccountId),
            eq(accounts.userId, userId),
            eq(accounts.type, 'credit_card'),
          ),
        );
      if (!card) throw new TRPCError({ code: 'NOT_FOUND', message: 'Card not found' });
    }
    const [rule] = await this.db
      .insert(classificationRules)
      .values({ ...input, userId, merchant: normalizeMerchant(input.merchant) })
      .returning();
    return rule;
  }
  async setRuleEnabled(userId: string, id: string, expectedVersion: number, enabled: boolean) {
    const [row] = await this.db
      .update(classificationRules)
      .set({ enabled, version: expectedVersion + 1 })
      .where(
        and(
          eq(classificationRules.userId, userId),
          eq(classificationRules.id, id),
          eq(classificationRules.version, expectedVersion),
        ),
      )
      .returning();
    if (!row) throw new TRPCError({ code: 'CONFLICT', message: 'Rule changed' });
    return row;
  }
  async preview(userId: string, raw: z.input<typeof classificationPeriodSchema>) {
    const input = classificationPeriodSchema.parse(raw);
    const scope = expensePeriodScope(userId, input.month, input.year);
    const rules = (await this.rules(userId)).filter((r) => r.enabled);
    const rows = await this.db
      .select()
      .from(transactions)
      .where(and(scope, input.cursor ? sql`${transactions.id} > ${input.cursor}::uuid` : undefined))
      .orderBy(transactions.id)
      .limit(101);
    const [coverage] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        reviewedCount: sql<number>`count(*) FILTER (WHERE ${transactions.classificationReviewedAt} IS NOT NULL AND ${transactions.categoryId} IS NOT NULL)::int`,
        totalAmount: sql<string>`coalesce(sum(${transactions.amount}) FILTER (WHERE ${transactions.currency} = 'BRL'),0)::text`,
        reviewedAmount: sql<string>`coalesce(sum(${transactions.amount}) FILTER (WHERE ${transactions.currency} = 'BRL' AND ${transactions.classificationReviewedAt} IS NOT NULL AND ${transactions.categoryId} IS NOT NULL),0)::text`,
        unknownResponsibilityCount: sql<number>`count(*) FILTER (WHERE ${transactions.economicResponsibility} = 'unknown')::int`,
        unsupportedCurrencyCount: sql<number>`count(*) FILTER (WHERE ${transactions.currency} <> 'BRL')::int`,
      })
      .from(transactions)
      .where(scope);
    const page = rows.slice(0, 100);
    return {
      items: page.map((row) => ({
        ...row,
        version: version(row),
        suggestion: suggestMerchantClassification(row.description, row.destinationAccountId, rules),
      })),
      nextCursor: rows.length > 100 ? (page.at(-1)?.id ?? null) : null,
      coverage: {
        ...coverage,
        totalAmount: Money.fromString(coverage.totalAmount, 'BRL').toDbString(),
        reviewedAmount: Money.fromString(coverage.reviewedAmount, 'BRL').toDbString(),
      },
    };
  }
  async apply(userId: string, raw: z.input<typeof classificationApplySchema>) {
    const input = classificationApplySchema.parse(raw);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new ClassificationService(db);
      if (input.categoryId) await service.category(userId, input.categoryId);
      if (input.receivableAccountId) {
        const [receivable] = await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.userId, userId),
              eq(accounts.id, input.receivableAccountId),
              eq(accounts.type, 'family_loan'),
            ),
          );
        if (!receivable)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Receivable not found' });
      }
      const [rule] = input.ruleId
        ? await db
            .select()
            .from(classificationRules)
            .where(
              and(
                eq(classificationRules.userId, userId),
                eq(classificationRules.id, input.ruleId),
                eq(classificationRules.version, input.ruleVersion ?? 0),
                eq(classificationRules.enabled, true),
              ),
            )
            .for('update')
        : [];
      if (input.ruleId && !rule) throw new TRPCError({ code: 'CONFLICT', message: 'Rule changed' });
      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(
              transactions.id,
              input.items.map((i) => i.id),
            ),
          ),
        )
        .orderBy(transactions.id)
        .for('update');
      if (rows.length !== input.items.length)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Transaction not found' });
      const changes = rows.map((row) => {
        if (
          !(
            row.domainType?.startsWith('credit_card_') ||
            ['loan_payment', 'loan_insurance', 'recurring_bill'].includes(row.domainType ?? '') ||
            (row.domainType === null && row.type === 'withdrawal')
          ) ||
          row.reversesTransactionId
        )
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Only expense occurrences can be classified',
          });
        if (version(row) !== input.items.find((i) => i.id === row.id)?.version || row.isReversed)
          throw new TRPCError({ code: 'CONFLICT', message: 'Transaction changed' });
        if (rule && row.classificationSource === 'manual')
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Preserve manual review; select a category explicitly',
          });
        const suggestion = rule
          ? suggestMerchantClassification(row.description, row.destinationAccountId, [rule])
          : null;
        if (rule && !suggestion)
          throw new TRPCError({ code: 'CONFLICT', message: 'Rule does not match transaction' });
        return { row, suggestion };
      });
      await assertOpenSettlementPeriods(db, userId, rows.flatMap(transactionPeriodDates));
      const items: typeof classificationBatches.$inferInsert.items = [];
      for (const { row, suggestion } of changes) {
        const [updated] = await db
          .update(transactions)
          .set({
            categoryId:
              suggestion?.categoryId ??
              (input.categoryId === undefined ? row.categoryId : input.categoryId),
            classificationSource: rule ? 'rule' : 'manual',
            classificationRuleId: rule?.id ?? null,
            classificationRuleVersion: rule?.version ?? null,
            classificationConfidence: suggestion?.confidence ?? null,
            classificationReviewedAt: new Date(),
            economicResponsibility: input.economicResponsibility ?? row.economicResponsibility,
            receivableAccountId:
              input.receivableAccountId === undefined
                ? row.receivableAccountId
                : input.receivableAccountId,
          })
          .where(and(eq(transactions.userId, userId), eq(transactions.id, row.id)))
          .returning();
        items.push({ transactionId: row.id, before: state(row), afterVersion: version(updated) });
      }
      const [batch] = await db.insert(classificationBatches).values({ userId, items }).returning();
      await new AuditService(db).log(
        userId,
        'classification.apply',
        'classification_batch',
        batch.id,
        undefined,
        { transactionIds: rows.map((r) => r.id) },
      );
      return { id: batch.id, count: items.length };
    });
  }
  async undo(userId: string, raw: z.input<typeof classificationUndoSchema>) {
    const input = classificationUndoSchema.parse(raw);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const [batch] = await db
        .select()
        .from(classificationBatches)
        .where(
          and(
            eq(classificationBatches.userId, userId),
            eq(classificationBatches.id, input.batchId),
          ),
        )
        .for('update');
      if (!batch || batch.undoneAt)
        throw new TRPCError({ code: 'CONFLICT', message: 'Batch unavailable' });
      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(
              transactions.id,
              batch.items.map((i) => i.transactionId),
            ),
          ),
        )
        .orderBy(transactions.id)
        .for('update');
      if (
        rows.length !== batch.items.length ||
        rows.some(
          (row) =>
            version(row) !== batch.items.find((i) => i.transactionId === row.id)?.afterVersion,
        )
      )
        throw new TRPCError({ code: 'CONFLICT', message: 'Transaction changed since review' });
      await assertOpenSettlementPeriods(db, userId, rows.flatMap(transactionPeriodDates));
      for (const item of batch.items) {
        await db
          .update(transactions)
          .set({
            ...item.before,
            classificationReviewedAt: item.before.classificationReviewedAt
              ? new Date(item.before.classificationReviewedAt)
              : null,
          })
          .where(and(eq(transactions.userId, userId), eq(transactions.id, item.transactionId)));
      }
      await db
        .update(classificationBatches)
        .set({ undoneAt: new Date(), undoReason: input.reason })
        .where(
          and(eq(classificationBatches.userId, userId), eq(classificationBatches.id, batch.id)),
        );
      await new AuditService(db).log(
        userId,
        'classification.undo',
        'classification_batch',
        batch.id,
        undefined,
        { reason: input.reason },
      );
      return { id: batch.id };
    });
  }
}
