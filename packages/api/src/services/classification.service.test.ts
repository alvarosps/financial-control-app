import type { DbExecutor } from '@fc/db';
import { accounts, categories, monthClosings, scheduledTransactions, transactions } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { ClassificationService } from './classification.service.ts';
import { MaterializerService } from './materializer.service.ts';
import { MonthClosingService } from './month-closing.service.ts';

async function fixture(db: DbExecutor) {
  const user = await createTestUser(db);
  const other = await createTestUser(db);
  const [expense, card, family] = await db
    .insert(accounts)
    .values(
      (['expense', 'credit_card', 'family_loan'] as const).map((type) => ({
        userId: user.id,
        name: type,
        type,
        currency: 'BRL',
      })),
    )
    .returning();
  const [food, work] = await db
    .insert(categories)
    .values(['Food', 'Work'].map((name) => ({ userId: user.id, name, type: 'expense' as const })))
    .returning();
  const insert = async (description = 'Café 123', amount = '100.00') =>
    (
      await db
        .insert(transactions)
        .values({
          userId: user.id,
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          amount,
          type: 'withdrawal',
          description,
          date: new Date('2026-09-15'),
          billingMonth: 9,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        })
        .returning()
    )[0];
  const row = await insert();
  return {
    user,
    other,
    expense,
    card,
    family,
    food,
    work,
    insert,
    row,
    service: new ClassificationService(db),
  };
}

describe('ClassificationService', () => {
  it('previews owned exact rules without mutating, applies reviewed batch and undoes with history', async () =>
    withRollback(async (db) => {
      const f = await fixture(db);
      const rule = await f.service.createRule(f.user.id, {
        merchant: 'cafe 123',
        cardAccountId: f.card.id,
        categoryId: f.food.id,
        priority: 10,
      });
      const preview = await f.service.preview(f.user.id, { month: 9, year: 2026 });
      expect(preview.items[0]).toMatchObject({
        categoryId: null,
        suggestion: { ruleId: rule.id, categoryId: f.food.id },
      });
      const batch = await f.service.apply(f.user.id, {
        items: preview.items.map(({ id, version }) => ({ id, version })),
        ruleId: rule.id,
        ruleVersion: rule.version,
        economicResponsibility: 'family',
        receivableAccountId: f.family.id,
      });
      const applied = await f.service.preview(f.user.id, { month: 9, year: 2026 });
      expect(applied.items[0]).toMatchObject({
        categoryId: f.food.id,
        classificationSource: 'rule',
        economicResponsibility: 'family',
        receivableAccountId: f.family.id,
      });
      expect(applied.coverage).toMatchObject({
        count: 1,
        reviewedCount: 1,
        totalAmount: '100.00',
        reviewedAmount: '100.00',
        unknownResponsibilityCount: 0,
      });
      await f.service.undo(f.user.id, { batchId: batch.id, reason: 'Wrong attribution' });
      expect(
        (await f.service.preview(f.user.id, { month: 9, year: 2026 })).items[0].categoryId,
      ).toBeNull();
      expect((await f.service.history(f.user.id))[0].undoneAt).not.toBeNull();
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(1);
    }));

  it('rejects stale batches atomically, foreign targets and overwriting a manual review with a rule', async () =>
    withRollback(async (db) => {
      const f = await fixture(db);
      await f.insert('Other', '50.00');
      const preview = await f.service.preview(f.user.id, { month: 9, year: 2026 });
      await db.update(transactions).set({ amount: '101.00' }).where(eq(transactions.id, f.row.id));
      await expect(
        f.service.apply(f.user.id, {
          items: preview.items.map(({ id, version }) => ({ id, version })),
          categoryId: f.food.id,
        }),
      ).rejects.toThrow(/changed/i);
      expect(
        (await f.service.preview(f.user.id, { month: 9, year: 2026 })).coverage.reviewedCount,
      ).toBe(0);
      const current = (await f.service.preview(f.user.id, { month: 9, year: 2026 })).items.find(
        (r) => r.id === f.row.id,
      );
      if (!current) throw new Error('fixture');
      await expect(
        f.service.apply(f.other.id, {
          items: [{ id: current.id, version: current.version }],
          categoryId: f.food.id,
        }),
      ).rejects.toThrow();
      await f.service.apply(f.user.id, {
        items: [{ id: current.id, version: current.version }],
        categoryId: f.work.id,
      });
      const manual = (await f.service.preview(f.user.id, { month: 9, year: 2026 })).items.find(
        (r) => r.id === f.row.id,
      );
      if (!manual) throw new Error('fixture');
      const rule = await f.service.createRule(f.user.id, {
        merchant: 'Café 123',
        categoryId: f.food.id,
      });
      await expect(
        f.service.apply(f.user.id, {
          items: [{ id: manual.id, version: manual.version }],
          ruleId: rule.id,
          ruleVersion: rule.version,
        }),
      ).rejects.toThrow(/manual/i);
    }));

  it('rejects application and undo in a closed month and rejects stale undo after another review', async () =>
    withRollback(async (db) => {
      const f = await fixture(db);
      const [item] = (await f.service.preview(f.user.id, { month: 9, year: 2026 })).items;
      const batch = await f.service.apply(f.user.id, {
        items: [{ id: item.id, version: item.version }],
        categoryId: f.food.id,
      });
      const [reviewed] = (await f.service.preview(f.user.id, { month: 9, year: 2026 })).items;
      await db
        .insert(monthClosings)
        .values({ userId: f.user.id, month: 9, year: 2026, status: 'closed' });
      await expect(
        f.service.undo(f.user.id, { batchId: batch.id, reason: 'Review' }),
      ).rejects.toThrow(/closed/i);
      await expect(
        f.service.apply(f.user.id, {
          items: [{ id: reviewed.id, version: reviewed.version }],
          categoryId: f.work.id,
        }),
      ).rejects.toThrow(/closed/i);
      await new MonthClosingService(db).reopenMonth(
        f.user.id,
        9,
        2026,
        'Review classification again',
      );
      await f.service.apply(f.user.id, {
        items: [{ id: reviewed.id, version: reviewed.version }],
        categoryId: f.work.id,
      });
      await expect(
        f.service.undo(f.user.id, { batchId: batch.id, reason: 'Review' }),
      ).rejects.toThrow(/changed/i);
    }));

  it('preserves a reviewed occurrence through schedule rematerialization', async () =>
    withRollback(async (db) => {
      const f = await fixture(db);
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId: f.user.id,
          sourceAccountId: f.expense.id,
          destinationAccountId: f.card.id,
          amount: '100.00',
          description: 'Café 123',
          startDate: new Date('2026-09-15'),
          frequency: 'monthly',
          totalOccurrences: 2,
          firstBillingMonth: 9,
          firstBillingYear: 2026,
          domainType: 'credit_card_installment',
        })
        .returning();
      await db
        .update(transactions)
        .set({
          scheduledTransactionId: schedule.id,
          installmentNumber: 1,
          totalInstallments: 2,
          domainType: 'credit_card_installment',
        })
        .where(eq(transactions.id, f.row.id));
      const [item] = (await f.service.preview(f.user.id, { month: 9, year: 2026 })).items;
      await f.service.apply(f.user.id, {
        items: [{ id: item.id, version: item.version }],
        categoryId: f.work.id,
        economicResponsibility: 'work',
      });
      await db
        .update(scheduledTransactions)
        .set({ amount: '125.00' })
        .where(eq(scheduledTransactions.id, schedule.id));
      await new MaterializerService(db).rematerializeForSchedule(f.user.id, schedule.id, 2);
      const [kept] = await db.select().from(transactions).where(eq(transactions.id, item.id));
      expect(kept).toMatchObject({
        categoryId: f.work.id,
        economicResponsibility: 'work',
        classificationSource: 'manual',
        amount: '125.00',
      });
    }));

  it('enforces RLS and owned category/card/receivable references even through SQL', async () =>
    withRollback(async (db) => {
      const f = await fixture(db);
      const rule = await f.service.createRule(f.user.id, {
        merchant: 'Café 123',
        categoryId: f.food.id,
      });
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', ${f.other.id}, true)`);
      expect(await f.service.rules(f.other.id)).toEqual([]);
      expect(
        await db.execute(sql`SELECT id FROM classification_rules WHERE id = ${rule.id}::uuid`),
      ).toHaveLength(0);
      await expect(
        db.transaction(async (tx) =>
          tx.execute(
            sql`INSERT INTO classification_rules(user_id, merchant, category_id) VALUES (${f.other.id}::uuid, 'stolen', ${f.food.id}::uuid)`,
          ),
        ),
      ).rejects.toThrow();
      await db.execute(sql`RESET ROLE`);
    }));
});
