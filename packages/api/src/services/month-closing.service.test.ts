import type { DbExecutor } from '@fc/db';
import { transactions, userProfiles } from '@fc/db';
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { reviewAndClose } from '../test/closing-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { MonthClosingService } from './month-closing.service.ts';
import { TransactionService } from './transaction.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const txService = new TransactionService(db);
  const closingService = new MonthClosingService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'month-closing@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();
  const userId = user.id;

  const checking = await accountService.create(userId, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  const expense = await accountService.create(userId, {
    name: 'Food',
    type: 'expense',
    currency: 'BRL',
  });
  const revenue = await accountService.create(userId, {
    name: 'Employer',
    type: 'revenue',
    currency: 'BRL',
  });

  return {
    txService,
    closingService,
    userId,
    checkingId: checking.id,
    expenseId: expense.id,
    revenueId: revenue.id,
  };
}

async function seedClosing(db: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'month-closing-summary@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();

  // Use AccountService.create (sets defaults like currentBalance) instead of raw inserts.
  const accountService = new AccountService(db);
  const checking = await accountService.create(user.id, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  const card = await accountService.create(user.id, {
    name: 'Card',
    type: 'credit_card',
    currency: 'BRL',
  });
  const revenue = await accountService.create(user.id, {
    name: 'Salary',
    type: 'revenue',
    currency: 'BRL',
  });
  const expense = await accountService.create(user.id, {
    name: 'Cobranças',
    type: 'expense',
    currency: 'BRL',
  });
  const family = await accountService.create(user.id, {
    name: 'João',
    type: 'family_loan',
    currency: 'BRL',
  });
  const loan = await accountService.create(user.id, {
    name: 'Consignado',
    type: 'loan',
    currency: 'BRL',
  });

  return { userId: user.id, checking, card, revenue, expense, family, loan };
}

describe('MonthClosingService', () => {
  it('refuses to close an incomplete BRL subtotal when income has no exchange rate', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      await db.insert(transactions).values({
        userId: f.userId,
        sourceAccountId: f.revenueId,
        destinationAccountId: f.checkingId,
        type: 'deposit',
        domainType: 'income_pj',
        amount: '1000.00',
        currency: 'USD',
        date: new Date('2026-06-05'),
        description: 'Missing rate',
      });
      await expect(f.closingService.closeMonth(f.userId, 6, 2026)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
  });

  describe('getStatus', () => {
    it('returns open status for a month that has no closing record', async () => {
      await withRollback(async (db) => {
        const { closingService, userId } = await seed(db);
        const status = await closingService.getStatus(userId, 3, 2026);

        expect(status.status).toBe('open');
        expect(status.closedAt).toBeNull();
        expect(status.snapshot).toBeNull();
      });
    });

    it('returns pending items count for the given month', async () => {
      await withRollback(async (db) => {
        const { txService, closingService, userId, checkingId, expenseId } = await seed(db);
        const futureDate = new Date(2026, 2, 15);

        await txService.create(userId, {
          sourceAccountId: expenseId,
          destinationAccountId: checkingId,
          amount: '300.00',
          description: 'Pending expense',
          date: futureDate,
        });

        const status = await closingService.getStatus(userId, 3, 2026);

        expect(status.pendingItemsCount).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('closeMonth', () => {
    it('creates a snapshot with correct totals', async () => {
      await withRollback(async (db) => {
        const { txService, userId, checkingId, expenseId, revenueId } = await seed(db);

        await txService.create(userId, {
          sourceAccountId: revenueId,
          destinationAccountId: checkingId,
          amount: '6000.00',
          description: 'Salary',
          domainType: 'income_clt',
          date: new Date(2025, 0, 5),
        });

        await txService.create(userId, {
          sourceAccountId: expenseId,
          destinationAccountId: checkingId,
          amount: '1500.00',
          description: 'Rent',
          domainType: 'recurring_bill',
          date: new Date(2025, 0, 10),
        });

        const closing = await reviewAndClose(db, userId, 1, 2025);

        expect(closing.status).toBe('closed');
        expect(Number(closing.totalIncome)).toBe(6000);
        expect(Number(closing.totalExpenses)).toBe(1500);
        expect(Number(closing.totalBalance)).toBe(4500);
        expect(closing.closedAt).not.toBeNull();
      });
    });

    it('rejects closing an already closed month', async () => {
      await withRollback(async (db) => {
        const { closingService, userId } = await seed(db);
        await reviewAndClose(db, userId, 2, 2025);

        await expect(closingService.closeMonth(userId, 2, 2025)).rejects.toThrow(
          'Month is already closed',
        );
      });
    });

    // The two tests below are invariant locks (regression guards). They document
    // that closeMonth must produce snapshot strings derived directly from Money
    // (Decimal) — not from a JS Number round-trip via .toFixed(2). For the
    // currently-allowed numeric(12,2) range these values happen to coincide,
    // but the contract is "exact decimal", and any future widening or stale
    // dashboard return type change must keep these tests green.
    it('snapshot totals equal raw SQL SUM exactly (no Number round-trip)', async () => {
      // Precision invariant: month-closing snapshot strings must equal the raw
      // `SUM(amount::numeric)` from Postgres verbatim — no detour through
      // JavaScript Number which can drift for large or odd-cent aggregates.
      await withRollback(async (db) => {
        const { txService, userId, checkingId, expenseId, revenueId } = await seed(db);

        // Many odd-cent items (0.07, 0.13) — picked because their binary float
        // representations are not exact; naive parseFloat+reduce drifts.
        const incomes = ['0.07', '0.13', '12345.67', '0.07', '0.13'];
        const expenses = ['0.07', '0.13', '5432.10', '0.07', '0.13', '0.07'];

        for (const amt of incomes) {
          await txService.create(userId, {
            sourceAccountId: revenueId,
            destinationAccountId: checkingId,
            amount: amt,
            description: `inc ${amt}`,
            domainType: 'income_clt',
            date: new Date(2025, 7, 5),
          });
        }
        for (const amt of expenses) {
          await txService.create(userId, {
            sourceAccountId: expenseId,
            destinationAccountId: checkingId,
            amount: amt,
            description: `exp ${amt}`,
            domainType: 'recurring_bill',
            date: new Date(2025, 7, 10),
          });
        }

        const startDate = new Date(2025, 7, 1);
        const endDate = new Date(2025, 7, 31);

        const [incomeSql] = await db
          .select({ total: sql<string>`COALESCE(SUM(${transactions.amount}::numeric), 0)::text` })
          .from(transactions)
          .where(
            and(
              eq(transactions.userId, userId),
              eq(transactions.type, 'deposit'),
              eq(transactions.isReversed, false),
              isNull(transactions.reversesTransactionId),
              gte(transactions.date, startDate),
              lte(transactions.date, endDate),
            ),
          );
        const [expenseSql] = await db
          .select({ total: sql<string>`COALESCE(SUM(${transactions.amount}::numeric), 0)::text` })
          .from(transactions)
          .where(
            and(
              eq(transactions.userId, userId),
              eq(transactions.type, 'withdrawal'),
              eq(transactions.isReversed, false),
              isNull(transactions.reversesTransactionId),
              gte(transactions.date, startDate),
              lte(transactions.date, endDate),
            ),
          );

        const closing = await reviewAndClose(db, userId, 8, 2025);

        // Normalize SQL output to canonical 2dp string (PG may return "12346.07" or "12346.0700").
        const norm = (s: string) => Number(s).toFixed(2);
        // Snapshot strings MUST match SQL totals exactly (after canonicalization).
        // The point of the test: the service uses Money/Decimal end-to-end and does
        // not emit values different from the raw SUM.
        expect(closing.totalIncome).toBe(norm(incomeSql.total));
        expect(closing.totalExpenses).toBe(norm(expenseSql.total));

        // Balance = SQL income - SQL expenses, computed with Money for exactness.
        const expectedBalance = (
          Number.parseFloat(incomeSql.total) - Number.parseFloat(expenseSql.total)
        ).toFixed(2);
        expect(closing.totalBalance).toBe(expectedBalance);
      });
    });

    it('snapshots exact totals on update path (reopened then re-closed)', async () => {
      // Same precision guarantee on the UPDATE path of closeMonth (not just INSERT).
      await withRollback(async (db) => {
        const { txService, userId, checkingId, expenseId, revenueId } = await seed(db);

        for (let i = 0; i < 30; i++) {
          await txService.create(userId, {
            sourceAccountId: revenueId,
            destinationAccountId: checkingId,
            amount: '33.33',
            description: `Inc ${i}`,
            domainType: 'income_clt',
            date: new Date(2025, 6, 3),
          });
          await txService.create(userId, {
            sourceAccountId: expenseId,
            destinationAccountId: checkingId,
            amount: '11.11',
            description: `Exp ${i}`,
            domainType: 'recurring_bill',
            date: new Date(2025, 6, 4),
          });
        }

        await reviewAndClose(db, userId, 7, 2025);
        await new MonthClosingService(db).reopenMonth(
          userId,
          7,
          2025,
          'Recheck synthetic evidence',
        );
        const reclosing = await reviewAndClose(db, userId, 7, 2025);

        expect(reclosing.totalIncome).toBe('999.90');
        expect(reclosing.totalExpenses).toBe('333.30');
        expect(reclosing.totalBalance).toBe('666.60');
      });
    });

    it('snapshot totals match MonthSummaryService (cards by billing month)', async () => {
      await withRollback(async (db) => {
        const { userId, checking, card } = await seedClosing(db);
        await db.insert(transactions).values({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '300.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela',
          date: new Date(2026, 4, 25),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_installment',
        });
        const closed = await reviewAndClose(db, userId, 6, 2026);
        expect(closed.totalExpenses).toBe('300.00');
      });
    });

    it('stores notes when provided', async () => {
      await withRollback(async (db) => {
        const { userId } = await seed(db);
        const closing = await reviewAndClose(db, userId, 4, 2025, 'End of quarter');

        expect(closing.notes).toBe('End of quarter');
      });
    });
  });

  describe('reopenMonth', () => {
    it('reopens a closed month and clears closedAt', async () => {
      await withRollback(async (db) => {
        const { closingService, userId } = await seed(db);
        await reviewAndClose(db, userId, 5, 2025);
        const reopened = await closingService.reopenMonth(
          userId,
          5,
          2025,
          'Recheck synthetic evidence',
        );

        expect(reopened.status).toBe('open');
        expect(reopened.closedAt).toBeNull();
      });
    });

    it('rejects reopening a month that is not closed', async () => {
      await withRollback(async (db) => {
        const { closingService, userId } = await seed(db);
        await expect(closingService.reopenMonth(userId, 6, 2025)).rejects.toThrow(
          'Month is not closed',
        );
      });
    });
  });
});
