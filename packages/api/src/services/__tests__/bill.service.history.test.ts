import type { DbExecutor } from '@fc/db';
import { transactions, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../../test/with-rollback.ts';
import { AccountService } from '../account.service.ts';
import { BillService } from '../bill.service.ts';
import { CreditCardFlowService } from '../credit-card-flow.service.ts';
import { MaterializationGuard } from '../materialization-guard.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const ccFlow = new CreditCardFlowService(db);
  const billService = new BillService(db, new MaterializationGuard(db));

  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'bill-history@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();
  const userId = user.id;

  const expense = await accountService.create(userId, {
    name: 'Food',
    type: 'expense',
    currency: 'BRL',
  });

  return { accountService, ccFlow, billService, userId, expenseId: expense.id };
}

function monthsAgo(n: number): { month: number; year: number } {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}

describe('BillService.getBillHistory', () => {
  it('returns exactly 12 entries ordered oldest→newest with correct totals and isPaid semantics', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      const m0 = monthsAgo(0); // current month — 2 unpaid
      const m3 = monthsAgo(3); // 3 months ago — 1 paid + 1 unpaid (mixed)
      const m6 = monthsAgo(6); // 6 months ago — 1 paid (all paid)

      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'cur-a',
          date: new Date(m0.year, m0.month - 1, 5),
          billingMonth: m0.month,
          billingYear: m0.year,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '50.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'cur-b',
          date: new Date(m0.year, m0.month - 1, 6),
          billingMonth: m0.month,
          billingYear: m0.year,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'm3-paid',
          date: new Date(m3.year, m3.month - 1, 5),
          billingMonth: m3.month,
          billingYear: m3.year,
          domainType: 'credit_card_expense',
          isPaid: true,
          paidAt: new Date(),
        },
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '25.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'm3-unpaid',
          date: new Date(m3.year, m3.month - 1, 6),
          billingMonth: m3.month,
          billingYear: m3.year,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '300.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'm6-paid',
          date: new Date(m6.year, m6.month - 1, 5),
          billingMonth: m6.month,
          billingYear: m6.year,
          domainType: 'credit_card_expense',
          isPaid: true,
          paidAt: new Date(),
        },
      ]);

      const history = await billService.getBillHistory(userId, account.id);

      expect(history).toHaveLength(12);

      // Ordered oldest→newest: history[0] is 11 months ago, history[11] is current month.
      expect(history[0]).toMatchObject(monthsAgo(11));
      expect(history[11]).toMatchObject(m0);

      // Current month (index 11): 2 unpaid, 150 total, not paid.
      expect(history[11]).toMatchObject({
        total: 150,
        paidTotal: 0,
        unpaidTotal: 150,
        transactionCount: 2,
        isPaid: false,
        dueDay: 10,
      });

      // m3 (index 8): mixed — 225 total, 200 paid, not fully paid.
      expect(history[8]).toMatchObject({
        month: m3.month,
        year: m3.year,
        total: 225,
        paidTotal: 200,
        unpaidTotal: 25,
        transactionCount: 2,
        isPaid: false,
      });

      // m6 (index 5): all paid.
      expect(history[5]).toMatchObject({
        month: m6.month,
        year: m6.year,
        total: 300,
        paidTotal: 300,
        unpaidTotal: 0,
        transactionCount: 1,
        isPaid: true,
      });

      // Empty months zero-filled with isPaid=false.
      for (const idx of [0, 1, 2, 3, 4, 6, 7, 9, 10]) {
        expect(history[idx]).toMatchObject({
          total: 0,
          paidTotal: 0,
          unpaidTotal: 0,
          transactionCount: 0,
          isPaid: false,
          dueDay: 10,
        });
      }
    });
  });

  it('returns dueDay=null when card has no creditCardConfigs row', async () => {
    await withRollback(async (db) => {
      const { accountService, billService, userId } = await seed(db);
      // Create a credit_card account directly (no config row).
      const card = await accountService.create(userId, {
        name: 'BareCard',
        type: 'credit_card',
        currency: 'BRL',
      });

      const history = await billService.getBillHistory(userId, card.id);
      expect(history).toHaveLength(12);
      for (const entry of history) {
        expect(entry.dueDay).toBeNull();
      }
    });
  });

  it('includes rows with domainType=NULL in totals', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      const m0 = monthsAgo(0);
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expenseId,
        destinationAccountId: account.id,
        amount: '77.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'null-domain',
        date: new Date(m0.year, m0.month - 1, 5),
        billingMonth: m0.month,
        billingYear: m0.year,
        domainType: null,
        isPaid: false,
      });

      const history = await billService.getBillHistory(userId, account.id);
      expect(history[11]).toMatchObject({
        total: 77,
        transactionCount: 1,
      });
    });
  });

  it('includes the month 11 months ago even when it crosses a year boundary', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      const m11 = monthsAgo(11);
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expenseId,
        destinationAccountId: account.id,
        amount: '42.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'edge-boundary',
        date: new Date(m11.year, m11.month - 1, 15),
        billingMonth: m11.month,
        billingYear: m11.year,
        domainType: 'credit_card_expense',
        isPaid: false,
      });

      const history = await billService.getBillHistory(userId, account.id);
      expect(history[0]).toMatchObject({
        month: m11.month,
        year: m11.year,
        total: 42,
        transactionCount: 1,
      });
    });
  });

  it('excludes bill_payment domainType rows from totals', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      const m0 = monthsAgo(0);
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'normal',
          date: new Date(m0.year, m0.month - 1, 5),
          billingMonth: m0.month,
          billingYear: m0.year,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '500.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'bill payment transfer',
          date: new Date(m0.year, m0.month - 1, 10),
          billingMonth: m0.month,
          billingYear: m0.year,
          domainType: 'bill_payment',
          isPaid: true,
          paidAt: new Date(),
        },
      ]);

      const history = await billService.getBillHistory(userId, account.id);
      expect(history[11]).toMatchObject({
        total: 100,
        transactionCount: 1,
        isPaid: false,
      });
    });
  });
});
