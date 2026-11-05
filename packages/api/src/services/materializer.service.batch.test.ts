import type { DbExecutor } from '@fc/db';
import { accounts, creditCardConfigs, scheduledTransactions, transactions } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { BillService } from './bill.service.ts';
import { MaterializationGuard } from './materialization-guard.service.ts';
import { MaterializerService } from './materializer.service.ts';

// Observe real insert statements, including nested transactions; all work reaches PostgreSQL.
function countInserts(db: DbExecutor, count: () => void): DbExecutor {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'transaction') {
        return (callback: (tx: DbExecutor) => Promise<unknown>) =>
          target.transaction((tx) => callback(countInserts(tx, count)));
      }
      if (key === 'insert') {
        return (...args: Parameters<DbExecutor['insert']>) => {
          count();
          return target.insert(...args);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('MaterializerService database round trips', () => {
  it('materializes hundreds of occurrences in bounded batches as app_user and stays idempotent', async () => {
    await withRollback(async (db) => {
      const { id: userId } = await createTestUser(db);
      const [expense, card] = await db
        .insert(accounts)
        .values([
          { userId, name: 'Expense', type: 'expense' },
          { userId, name: 'Card', type: 'credit_card' },
        ])
        .returning();
      await db.insert(creditCardConfigs).values({ accountId: card.id, closingDay: 20, dueDay: 25 });
      const now = new Date();
      await db.insert(scheduledTransactions).values(
        Array.from({ length: 50 }, (_, index) => ({
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          amount: '10.00',
          description: `Recurring charge ${index}`,
          frequency: 'monthly' as const,
          startDate: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 5)),
          dueDay: 5,
          startingOccurrence: 1,
          domainType: 'credit_card_fixed_charge' as const,
        })),
      );
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
      let inserts = 0;
      const counted = countInserts(db, () => inserts++);
      const bill = await new BillService(
        counted,
        new MaterializationGuard(counted),
      ).getConsolidatedBill(userId, card.id, now.getMonth() + 1, now.getFullYear());
      expect(bill).toMatchObject({ total: 500, unpaidTotal: 500, transactionCount: 50 });
      expect(inserts).toBeLessThanOrEqual(4);
      const second = await new MaterializerService(counted).materialize(userId, 12);
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(600);
      const rows = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(rows).toHaveLength(600);
      expect(
        new Set(rows.map((row) => `${row.scheduledTransactionId}|${row.date.toISOString()}`)).size,
      ).toBe(600);
      const [balance] = await db
        .select({ value: accounts.currentBalance })
        .from(accounts)
        .where(eq(accounts.id, card.id));
      expect(balance.value).toBe('6000.00');
    });
  }, 30_000);
});
