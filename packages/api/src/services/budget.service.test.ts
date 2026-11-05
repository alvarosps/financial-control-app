import {
  budgets,
  categories,
  purchaseLedgerLinks,
  purchaseObservations,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { BudgetService, budgetCreateSchema } from './budget.service.ts';

describe('BudgetService', () => {
  it('uses canonical card competence, separates schedules and excludes bill payments/transfers/receipts', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const [category] = await db
        .insert(categories)
        .values({ userId: f.user.id, name: 'Food', type: 'expense' })
        .returning();
      const service = new BudgetService(db, () => new Date('2026-09-28T15:00:00Z'));
      await service.create(f.user.id, {
        month: 9,
        year: 2026,
        limitAmount: '500.00',
        economicScope: 'own',
      });
      const base = {
        userId: f.user.id,
        sourceAccountId: f.expense.id,
        destinationAccountId: f.card.id,
        amount: '100.00',
        type: 'withdrawal' as const,
        description: 'Fixture',
        date: new Date('2026-08-30'),
        billingMonth: 9,
        billingYear: 2026,
        categoryId: category.id,
      };
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          ...base,
          domainType: 'credit_card_installment',
          startDate: new Date('2026-09-01'),
          frequency: 'monthly',
          isActive: true,
        })
        .returning();
      const rows = await db
        .insert(transactions)
        .values([
          { ...base, domainType: 'credit_card_expense' },
          { ...base, domainType: 'credit_card_refund', amount: '20.00' },
          {
            ...base,
            domainType: 'credit_card_installment',
            scheduledTransactionId: schedule.id,
            date: new Date('2026-09-15'),
          },
          { ...base, domainType: 'credit_card_expense', economicResponsibility: 'family' },
          { ...base, domainType: 'credit_card_expense', billingMonth: 10 },
          { ...base, domainType: 'loan_payment', amount: '50.00', date: new Date('2026-09-15') },
          { ...base, domainType: 'recurring_bill', amount: '30.00', date: new Date('2026-09-15') },
          { ...base, domainType: 'bill_payment', type: 'transfer', date: new Date('2026-09-15') },
          {
            ...base,
            domainType: 'family_loan_payment',
            type: 'deposit',
            date: new Date('2026-09-15'),
          },
          { ...base, domainType: null, type: 'transfer', date: new Date('2026-09-15') },
        ])
        .returning();
      const [linked, pending] = await db
        .insert(purchaseObservations)
        .values(
          [1, 2].map((n) => ({
            userId: f.user.id,
            cardAccountId: f.card.id,
            amount: '10.00',
            description: `Event ${n}`,
            purchaseDate: '2026-09-15',
            amountMeaning: 'purchase_total' as const,
          })),
        )
        .returning();
      await db.insert(purchaseLedgerLinks).values({
        userId: f.user.id,
        observationId: linked.id,
        transactionId: rows[0].id,
        application: 'linked',
      });
      const result = await service.list(f.user.id, { month: 9, year: 2026 });
      expect(result.items[0].progress).toMatchObject({
        confirmed: '80.00',
        committed: '180.00',
        provisional: '10.00',
        excluded: '100.00',
        reliable: false,
      });
      expect(result.summary).toMatchObject({
        confirmed: '180.00',
        committed: '180.00',
        uncategorized: '10.00',
      });
      expect(result.provisional.estimatedCount).toBe(1);
      await db
        .update(purchaseObservations)
        .set({ amountMeaning: 'unknown' })
        .where(eq(purchaseObservations.id, pending.id));
      expect(
        (await service.list(f.user.id, { month: 9, year: 2026 })).provisional.unallocatedCount,
      ).toBe(1);
    }));
  it('updates only the expected version and enforces ownership in services and RLS', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db),
        other = await purchaseFixture(db);
      const service = new BudgetService(db);
      const created = await service.create(f.user.id, {
        month: 9,
        year: 2026,
        limitAmount: '500.00',
      });
      const attempts = await Promise.allSettled([
        service.update(f.user.id, {
          id: created.id,
          version: created.version,
          limitAmount: '600.00',
        }),
        service.update(f.user.id, {
          id: created.id,
          version: created.version,
          limitAmount: '700.00',
        }),
      ]);
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
      await expect(
        service.update(other.user.id, { id: created.id, version: 2, limitAmount: '10.00' }),
      ).rejects.toThrow();
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', ${other.user.id}, true)`);
      expect(await db.select().from(budgets).where(eq(budgets.id, created.id))).toEqual([]);
    }));
  it('rejects foreign categories and unsupported currencies without financial writes', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db),
        other = await purchaseFixture(db);
      const [category] = await db
        .insert(categories)
        .values({ userId: other.user.id, name: 'Foreign', type: 'expense' })
        .returning();
      const service = new BudgetService(db);
      await expect(
        service.create(f.user.id, {
          month: 9,
          year: 2026,
          limitAmount: '100.00',
          categoryId: category.id,
        }),
      ).rejects.toThrow();
      expect(() =>
        budgetCreateSchema.parse({ month: 9, year: 2026, limitAmount: '100.00', currency: 'USD' }),
      ).toThrow();
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(0);
    }));
});
