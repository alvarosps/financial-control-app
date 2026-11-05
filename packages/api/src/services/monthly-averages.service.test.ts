import type { DbExecutor } from '@fc/db';
import { scheduledTransactions, transactions, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { MonthlyAveragesService } from './monthly-averages.service.ts';

// asOf fixed at 2026-06-16 → current month = June → the complete months
// immediately before are Dec 2025, Jan, Feb, Mar, Apr, May 2026 (the last 6 of
// the default 12-month window; the 6 before that are empty pre-history).
const ASOF = new Date(Date.UTC(2026, 5, 16));

const WINDOW = [
  { month: 12, year: 2025 },
  { month: 1, year: 2026 },
  { month: 2, year: 2026 },
  { month: 3, year: 2026 },
  { month: 4, year: 2026 },
  { month: 5, year: 2026 },
];

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'monthly-averages@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();
  const userId = user.id;

  const checking = await accountService.create(userId, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  const card = await accountService.create(userId, {
    name: 'Card',
    type: 'credit_card',
    currency: 'BRL',
  });
  const expense = await accountService.create(userId, {
    name: 'Food',
    type: 'expense',
    currency: 'BRL',
  });

  return { userId, checkingId: checking.id, cardId: card.id, expenseId: expense.id };
}

describe('MonthlyAveragesService.getMonthlyAverages', () => {
  it('excludes a statistical spike (median+MAD) from the typical average but keeps it in the raw average', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId, cardId, expenseId } = await seed(db);

      // A steady 1000.00/month uncategorized ("other") expense in each of the 6
      // months with data. Dated mid-month so it lands squarely in its month.
      const otherRows = WINDOW.map((w) => ({
        userId,
        sourceAccountId: checkingId,
        destinationAccountId: expenseId,
        amount: '1000.00',
        currency: 'BRL',
        type: 'withdrawal' as const,
        description: 'avulso',
        date: new Date(Date.UTC(w.year, w.month - 1, 15)),
        domainType: null,
      }));
      await db.insert(transactions).values(otherRows);

      // Two NEW credit-card installments whose FIRST occurrence
      // (installmentNumber = 1) lands inside the window: 600 in Feb 2026 and
      // 900 in Apr 2026. Card spend is bucketed by billing month, but the
      // new-installment signal is the first occurrence by date.
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: cardId,
          amount: '600.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela nova A',
          date: new Date(Date.UTC(2026, 1, 10)), // Feb 2026
          billingMonth: 2,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          installmentNumber: 1,
          totalInstallments: 10,
        },
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: cardId,
          amount: '900.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela nova B',
          date: new Date(Date.UTC(2026, 3, 12)), // Apr 2026
          billingMonth: 4,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          installmentNumber: 1,
          totalInstallments: 12,
        },
        // A LATER occurrence of an installment (installmentNumber = 3) inside the
        // window — it is NOT a new installment and must be excluded.
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: cardId,
          amount: '300.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela antiga (3/10)',
          date: new Date(Date.UTC(2026, 2, 8)), // Mar 2026
          billingMonth: 3,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          installmentNumber: 3,
          totalInstallments: 10,
        },
      ]);

      const result = await new MonthlyAveragesService(db).getMonthlyAverages(userId, {
        asOf: ASOF,
      });

      // Per-month totals: 1000 other + (card billing-month spend). Card spend
      // bucketed by billing month: Feb 600, Mar 300, Apr 900. So totals are
      // Dec 1000, Jan 1000, Feb 1600, Mar 1300, Apr 1900, May 1000.
      // Over those 6 totals: median = 1150, MAD = 150, 3.5*MAD = 525.
      // April (1900, dev 750) exceeds 525 → statistical outlier. Feb (1600,
      // dev 450) does NOT → kept. So 5 typical months remain.
      expect(result.window).toBe(12);
      expect(result.monthsWithData).toBe(6);
      expect(result.monthsUsed).toBe(5);

      // April is the single excluded month, flagged statistical.
      expect(result.excludedMonths).toEqual([
        { month: 4, year: 2026, total: '1900.00', reasons: ['statistical'] },
      ]);

      // Raw average includes April: 7800 / 6 = 1300.00.
      expect(result.rawAverageMonthlySpend).toBe('1300.00');
      // Typical average drops April: (7800 - 1900) / 5 = 5900 / 5 = 1180.00.
      expect(result.averageMonthlySpend).toBe('1180.00');

      // byCategory over the 5 typical months (April excluded).
      // other = 5 * 1000 / 5 = 1000.
      expect(result.byCategory.other).toBe('1000.00');
      // creditCard = (Feb 600 + Mar 300) / 5 = 900 / 5 = 180 (April's 900 dropped).
      expect(result.byCategory.creditCard).toBe('180.00');
      expect(result.byCategory.loan).toBe('0.00');
      expect(result.byCategory.charge).toBe('0.00');

      // New installments in typical months: Feb 600 kept, Apr 900 dropped → 600 / 5 = 120.
      expect(result.averageNewInstallment).toBe('120.00');
    });
  });

  it('does not apply the statistical test below minData and averages over months with data (sparse history)', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId, expenseId } = await seed(db);

      // Only TWO of the window months have any data: 2000 in Jan, 4000 in May.
      // n = 2 < minData (4) → no statistical exclusion despite the spread.
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '2000.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'avulso jan',
          date: new Date(Date.UTC(2026, 0, 15)),
          domainType: null,
        },
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '4000.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'avulso may',
          date: new Date(Date.UTC(2026, 4, 15)),
          domainType: null,
        },
      ]);

      const result = await new MonthlyAveragesService(db).getMonthlyAverages(userId, {
        asOf: ASOF,
      });

      // Empty pre-history months are skipped; nothing excluded → typical == raw.
      expect(result.window).toBe(12);
      expect(result.monthsWithData).toBe(2);
      expect(result.monthsUsed).toBe(2);
      expect(result.excludedMonths).toEqual([]);
      expect(result.averageMonthlySpend).toBe('3000.00');
      expect(result.rawAverageMonthlySpend).toBe('3000.00');
      expect(result.byCategory.other).toBe('3000.00');
      // No installments started in the window → new-installment average is 0.
      expect(result.averageNewInstallment).toBe('0.00');
    });
  });

  it('returns zeros and zero counts for a user with no recorded history', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);

      const result = await new MonthlyAveragesService(db).getMonthlyAverages(userId, {
        asOf: ASOF,
      });

      expect(result.window).toBe(12);
      expect(result.monthsWithData).toBe(0);
      expect(result.monthsUsed).toBe(0);
      expect(result.excludedMonths).toEqual([]);
      expect(result.averageMonthlySpend).toBe('0.00');
      expect(result.rawAverageMonthlySpend).toBe('0.00');
      expect(result.averageNewInstallment).toBe('0.00');
      expect(result.byCategory).toEqual({
        creditCard: '0.00',
        loan: '0.00',
        charge: '0.00',
        other: '0.00',
      });
    });
  });

  it('never reads another user data (userId-scoped)', async () => {
    await withRollback(async (db) => {
      const { userId: userA, checkingId, expenseId } = await seed(db);
      const accountService = new AccountService(db);
      const [userBRow] = await db
        .insert(userProfiles)
        .values({ email: 'monthly-averages-b@test.com', name: 'B', passwordHash: 'hash' })
        .returning();
      const userB = userBRow.id;

      // User A has a big steady expense across the window.
      await db.insert(transactions).values(
        WINDOW.map((w) => ({
          userId: userA,
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '5000.00',
          currency: 'BRL',
          type: 'withdrawal' as const,
          description: 'avulso A',
          date: new Date(Date.UTC(w.year, w.month - 1, 15)),
          domainType: null,
        })),
      );
      // User B has its own checking/expense but no transactions.
      await accountService.create(userB, { name: 'B bank', type: 'checking', currency: 'BRL' });

      const result = await new MonthlyAveragesService(db).getMonthlyAverages(userB, {
        asOf: ASOF,
      });

      expect(result.monthsWithData).toBe(0);
      expect(result.monthsUsed).toBe(0);
      expect(result.averageMonthlySpend).toBe('0.00');
      expect(result.averageNewInstallment).toBe('0.00');
    });
  });

  it('flags a month as an IOF trip-signal outlier even when too few months for the statistical test', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId, cardId, expenseId } = await seed(db);

      // Three data months (n = 3 < minData) so the statistical test cannot fire.
      // Mar and May are plain 1000 "other"; April is 1000 "other" PLUS an
      // 80.00 IOF card charge (foreign-currency tax) bucketed to April by its
      // billing month → April carries IOF above the 10 BRL threshold.
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'avulso mar',
          date: new Date(Date.UTC(2026, 2, 15)), // Mar 2026
          domainType: null,
        },
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'avulso abr',
          date: new Date(Date.UTC(2026, 3, 15)), // Apr 2026
          domainType: null,
        },
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: cardId,
          amount: '80.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'IOF compra internacional',
          date: new Date(Date.UTC(2026, 3, 20)), // dated April, billed April
          billingMonth: 4,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        },
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'avulso mai',
          date: new Date(Date.UTC(2026, 4, 15)), // May 2026
          domainType: null,
        },
      ]);

      const result = await new MonthlyAveragesService(db).getMonthlyAverages(userId, {
        asOf: ASOF,
      });

      // April total = 1000 other + 80 IOF card (bucketed by billing month) = 1080.
      expect(result.monthsWithData).toBe(3);
      expect(result.monthsUsed).toBe(2);
      expect(result.excludedMonths).toEqual([
        { month: 4, year: 2026, total: '1080.00', reasons: ['iof'] },
      ]);
      // Typical average over Mar + May = (1000 + 1000) / 2 = 1000.
      expect(result.averageMonthlySpend).toBe('1000.00');
      // Raw average includes April: (1000 + 1080 + 1000) / 3 = 3080 / 3 = 1026.67.
      expect(result.rawAverageMonthlySpend).toBe('1026.67');
    });
  });

  it('honors the requested window (only the most recent N complete months are considered)', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId, expenseId } = await seed(db);

      // 1000 in EACH of the 6 default-window months.
      await db.insert(transactions).values(
        WINDOW.map((w) => ({
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal' as const,
          description: 'avulso',
          date: new Date(Date.UTC(w.year, w.month - 1, 15)),
          domainType: null,
        })),
      );

      const result = await new MonthlyAveragesService(db).getMonthlyAverages(userId, {
        window: 3,
        asOf: ASOF,
      });

      // window = 3 → only Mar, Apr, May 2026 are in scope; the older 3 months
      // (Dec, Jan, Feb) are outside the window even though they have data.
      expect(result.window).toBe(3);
      expect(result.monthsWithData).toBe(3);
    });
  });
});

describe('MonthlyAveragesService.getInstallmentSuggestions', () => {
  it('returns only installment schedules (startingOccurrence 1 + non-null totalOccurrences), most recent first', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId, cardId } = await seed(db);

      await db.insert(scheduledTransactions).values([
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: cardId,
          amount: '500.00',
          currency: 'BRL',
          description: 'Notebook',
          frequency: 'monthly',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          totalOccurrences: 12,
          startingOccurrence: 1,
          domainType: 'credit_card_installment',
        },
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: cardId,
          amount: '200.00',
          currency: 'BRL',
          description: 'Geladeira',
          frequency: 'monthly',
          startDate: new Date(Date.UTC(2026, 3, 1)),
          totalOccurrences: 5,
          startingOccurrence: 1,
          domainType: 'credit_card_installment',
        },
        // A non-installment schedule (no totalOccurrences) — must be excluded.
        {
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: cardId,
          amount: '40.00',
          currency: 'BRL',
          description: 'Netflix',
          frequency: 'monthly',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          totalOccurrences: null,
          startingOccurrence: 1,
          domainType: 'credit_card_fixed_charge',
        },
      ]);

      const result = await new MonthlyAveragesService(db).getInstallmentSuggestions(userId);

      // Both installment rows share a createdAt (one insert call), so the
      // startDate-desc tiebreaker decides order: Geladeira (Apr) before
      // Notebook (Jan). Netflix is excluded.
      expect(result).toEqual([
        { label: 'Geladeira', amount: '200.00', installments: 5 },
        { label: 'Notebook', amount: '500.00', installments: 12 },
      ]);
    });
  });

  it('never reads another user installment schedules (userId-scoped)', async () => {
    await withRollback(async (db) => {
      const { userId: userA, checkingId, cardId } = await seed(db);
      const [userBRow] = await db
        .insert(userProfiles)
        .values({ email: 'monthly-averages-suggest-b@test.com', name: 'B', passwordHash: 'hash' })
        .returning();
      const userB = userBRow.id;

      // User A has an installment schedule; user B has none.
      await db.insert(scheduledTransactions).values({
        userId: userA,
        sourceAccountId: checkingId,
        destinationAccountId: cardId,
        amount: '300.00',
        currency: 'BRL',
        description: 'Celular',
        frequency: 'monthly',
        startDate: new Date(Date.UTC(2026, 0, 1)),
        totalOccurrences: 10,
        startingOccurrence: 1,
        domainType: 'credit_card_installment',
      });

      const result = await new MonthlyAveragesService(db).getInstallmentSuggestions(userB);

      expect(result).toEqual([]);
    });
  });
});
