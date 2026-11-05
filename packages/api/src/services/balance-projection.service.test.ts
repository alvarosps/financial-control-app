import type { DbExecutor } from '@fc/db';
import { accounts, transactions, userProfiles } from '@fc/db';
import { foldRunningBalance, Money } from '@fc/domain';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { BalanceProjectionService } from './balance-projection.service.ts';
import { MonthOverviewService } from './month-overview.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'balance-proj@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();
  const userId = user.id;

  const checking = await accountService.create(userId, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  const revenue = await accountService.create(userId, {
    name: 'Employer',
    type: 'revenue',
    currency: 'BRL',
  });
  const expense = await accountService.create(userId, {
    name: 'Food',
    type: 'expense',
    currency: 'BRL',
  });
  const loan = await accountService.create(userId, { name: 'Loan', type: 'loan', currency: 'BRL' });
  const card = await accountService.create(userId, {
    name: 'Card',
    type: 'credit_card',
    currency: 'BRL',
  });

  // Anchor the wallet to a fixed past instant with a known opening balance so a
  // post-anchor PAID movement is what WalletCashService accumulates.
  await db
    .update(accounts)
    .set({
      openingBalance: '1000.00',
      openingBalanceAnchorAt: new Date(Date.UTC(2026, 4, 1)), // 2026-05-01
    })
    .where(eq(accounts.id, checking.id));

  return {
    userId,
    checkingId: checking.id,
    revenueId: revenue.id,
    expenseId: expense.id,
    loanId: loan.id,
    cardId: card.id,
  };
}

describe('BalanceProjectionService', () => {
  describe('getAnchorCash', () => {
    it('equals WalletCashService.totalCash as a BRL money string', async () => {
      await withRollback(async (db) => {
        const { userId, revenueId, checkingId } = await seed(db);
        const asOf = new Date(Date.UTC(2026, 5, 16)); // 2026-06-16

        await db.insert(transactions).values({
          userId,
          sourceAccountId: revenueId,
          destinationAccountId: checkingId,
          amount: '500.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'income_clt',
          date: new Date(Date.UTC(2026, 5, 5)),
          domainType: 'income_clt',
          isPaid: true,
          paidAt: new Date(Date.UTC(2026, 5, 5)),
        });

        const service = new BalanceProjectionService(db);
        const anchor = await service.getAnchorCash(userId, asOf);

        const { totalCash } = await new WalletCashService(db).getWalletCash(userId, asOf);
        expect(totalCash).toBe(1500);
        expect(anchor).toBe(Money.fromNumber(totalCash, 'BRL').toDbString());
        expect(anchor).toBe('1500.00');
      });
    });
  });

  describe('getBaselineCores future months', () => {
    it('future-month net equals full MonthSummary net, with per-bucket mapping', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId, expenseId, revenueId, loanId, cardId } = await seed(db);
        const asOf = new Date(Date.UTC(2026, 5, 16)); // 2026-06-16 → month 0 = June
        // +2 months from June = August 2026 (index 2 of the horizon window).
        const augMonth = 8;
        const augYear = 2026;

        // Income deposit, dated in August. isPaid:false → a future, unsettled row.
        await db.insert(transactions).values({
          userId,
          sourceAccountId: revenueId,
          destinationAccountId: checkingId,
          amount: '5000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'income_clt',
          date: new Date(Date.UTC(augYear, augMonth - 1, 5)),
          domainType: 'income_clt',
          isPaid: false,
        });
        // Credit-card installment, billed in August.
        await db.insert(transactions).values({
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: cardId,
          amount: '700.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'credit_card_installment',
          date: new Date(Date.UTC(augYear, augMonth - 1, 7)),
          domainType: 'credit_card_installment',
          billingMonth: augMonth,
          billingYear: augYear,
          isPaid: false,
        });
        // Loan payment, dated in August.
        await db.insert(transactions).values({
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: loanId,
          amount: '800.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'loan_payment',
          date: new Date(Date.UTC(augYear, augMonth - 1, 8)),
          domainType: 'loan_payment',
          isPaid: false,
        });
        // Recurring charge, dated in August.
        await db.insert(transactions).values({
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '200.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'recurring_bill',
          date: new Date(Date.UTC(augYear, augMonth - 1, 9)),
          domainType: 'recurring_bill',
          isPaid: false,
        });

        const service = new BalanceProjectionService(db);
        const cores = await service.getBaselineCores(userId, { horizon: 12, asOf });

        const aug = cores.find((c) => c.month === augMonth && c.year === augYear);
        expect(aug).toBeDefined();
        if (!aug) throw new Error('august core missing');

        // Buckets mapped from MonthSummary.
        expect(aug.income.base).toBe(5000);
        expect(aug.income.familyLoan).toBe(0);
        expect(aug.income.lever).toBe(0);
        expect(aug.income.total).toBe(5000);
        expect(aug.expenses.creditCard).toBe(700);
        expect(aug.expenses.loan).toBe(800);
        expect(aug.expenses.charge).toBe(200);
        expect(aug.expenses.other).toBe(0);
        expect(aug.expenses.lever).toBe(0);
        expect(aug.expenses.total).toBe(1700);
        expect(aug.events).toEqual([]);

        // net === full MonthSummary balance for that month.
        const s = await new MonthSummaryService(db).getSummary(userId, augMonth, augYear);
        expect(aug.net).toBeCloseTo(s.balance, 2);
        expect(aug.net).toBe(3300); // 5000 − 1700
      });
    });
  });

  describe('getBaselineCores current-month unpaid rule', () => {
    it('current-month net excludes a PAID expense but includes an UNPAID one', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId, expenseId, revenueId } = await seed(db);
        const asOf = new Date(Date.UTC(2026, 5, 16)); // 2026-06-16 → current month = June

        // PAID charge this month — already settled, already in the anchor. Must
        // NOT appear in the current-month net (it would be double-counted).
        await db.insert(transactions).values({
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '300.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'recurring_bill paid',
          date: new Date(Date.UTC(2026, 5, 5)),
          domainType: 'recurring_bill',
          isPaid: true,
          paidAt: new Date(Date.UTC(2026, 5, 5)),
        });
        // UNPAID charge this month — still owed → counts against current-month net.
        await db.insert(transactions).values({
          userId,
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '200.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'recurring_bill unpaid',
          date: new Date(Date.UTC(2026, 5, 20)),
          domainType: 'recurring_bill',
          isPaid: false,
        });
        // UNPAID income occurrence this month — still to receive → counts.
        await db.insert(transactions).values({
          userId,
          sourceAccountId: revenueId,
          destinationAccountId: checkingId,
          amount: '1000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'income_clt unpaid',
          date: new Date(Date.UTC(2026, 5, 25)),
          domainType: 'income_clt',
          isPaid: false,
        });

        const service = new BalanceProjectionService(db);
        const cores = await service.getBaselineCores(userId, { horizon: 12, asOf });
        const june = cores[0];
        expect(june.month).toBe(6);
        expect(june.year).toBe(2026);

        // Only the UNPAID charge counts; the paid 300 is excluded.
        expect(june.expenses.charge).toBe(200);
        expect(june.expenses.total).toBe(200);
        // Only the UNPAID income counts.
        expect(june.income.base).toBe(1000);
        expect(june.income.total).toBe(1000);
        // net = unpaidIncome − unpaidExpense.
        expect(june.net).toBe(800);

        // Cross-check the unpaid expense remainder agrees with MonthOverviewService.toPay.
        const overview = await new MonthOverviewService(db).getOverview(userId, 6, 2026, 45, asOf);
        expect(june.expenses.charge).toBeCloseTo(overview.toPay.charges, 2);
      });
    });
  });

  describe('getBaselineCores horizon + end-to-end fold', () => {
    it('honors the horizon length (1..37) and rejects out-of-range', async () => {
      await withRollback(async (db) => {
        const { userId } = await seed(db);
        const asOf = new Date(Date.UTC(2026, 5, 16));
        const service = new BalanceProjectionService(db);

        expect(await service.getBaselineCores(userId, { horizon: 1, asOf })).toHaveLength(1);
        expect(await service.getBaselineCores(userId, { horizon: 6, asOf })).toHaveLength(6);
        // 37 is the upper bound: the simulator fetches `horizon + 1` cores, so a
        // user-facing 36-month projection requests an internal horizon of 37.
        expect(await service.getBaselineCores(userId, { horizon: 37, asOf })).toHaveLength(37);

        await expect(service.getBaselineCores(userId, { horizon: 0, asOf })).rejects.toThrow(
          /horizon/i,
        );
        await expect(service.getBaselineCores(userId, { horizon: 38, asOf })).rejects.toThrow(
          /horizon/i,
        );
      });
    });

    it('folds anchor + baseline cores into a carried running balance', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId, expenseId, revenueId } = await seed(db);
        const asOf = new Date(Date.UTC(2026, 5, 16)); // June current month

        // A future-month (August) net of +3300 so the carry is observable.
        await db.insert(transactions).values([
          {
            userId,
            sourceAccountId: revenueId,
            destinationAccountId: checkingId,
            amount: '5000.00',
            currency: 'BRL',
            type: 'deposit',
            description: 'income_clt',
            date: new Date(Date.UTC(2026, 7, 5)),
            domainType: 'income_clt',
            isPaid: false,
          },
          {
            userId,
            sourceAccountId: checkingId,
            destinationAccountId: expenseId,
            amount: '1700.00',
            currency: 'BRL',
            type: 'transfer',
            description: 'recurring_bill',
            date: new Date(Date.UTC(2026, 7, 9)),
            domainType: 'recurring_bill',
            isPaid: false,
          },
        ]);

        const service = new BalanceProjectionService(db);
        // anchor = '1000.00' (opening balance, no post-anchor cash movements).
        const anchor = await service.getAnchorCash(userId, asOf);
        const cores = await service.getBaselineCores(userId, { horizon: 12, asOf });
        const projected = foldRunningBalance(cores, anchor);

        // opening[0] === anchor.
        expect(projected[0].openingBalance).toBe(1000);
        // endingBalance(m) === openingBalance(m) + net.
        for (const p of projected) {
          expect(p.endingBalance).toBeCloseTo(p.openingBalance + p.net, 2);
        }
        // carry: opening[m+1] === ending[m].
        for (let i = 0; i + 1 < projected.length; i++) {
          expect(projected[i + 1].openingBalance).toBeCloseTo(projected[i].endingBalance, 2);
        }
        // August (index 2) net is +3300, so ending steps up by 3300 vs its opening.
        const aug = projected.find((p) => p.month === 8 && p.year === 2026);
        expect(aug).toBeDefined();
        if (!aug) throw new Error('august missing');
        expect(aug.net).toBeCloseTo(3300, 2);
        expect(aug.endingBalance).toBeCloseTo(aug.openingBalance + 3300, 2);
      });
    });
  });
});
