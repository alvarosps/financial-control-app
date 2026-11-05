import {
  accounts,
  creditCardConfigs,
  incomeSourceConfigs,
  scheduledTransactions,
  transactions,
  userProfiles,
} from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { MonthOverviewService } from './month-overview.service.ts';

async function seed(db: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'month-overview@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();

  const accountService = new AccountService(db);
  const checking = await accountService.create(user.id, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  // AccountService.create stamps openingBalanceAnchorAt=now; these fixtures reason
  // about historical paid movements, so backdate the anchor to count them all.
  await db
    .update(accounts)
    .set({ openingBalanceAnchorAt: new Date(Date.UTC(2000, 0, 1)) })
    .where(eq(accounts.id, checking.id));
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
  const savings = await accountService.create(user.id, {
    name: 'Poupança',
    type: 'savings',
    currency: 'BRL',
  });

  return { userId: user.id, checking, card, revenue, expense, family, loan, savings };
}

async function seedUser(db: Parameters<Parameters<typeof withRollback>[0]>[0]): Promise<string> {
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `month-overview-${Math.random().toString(36).slice(2)}@test.com`,
      name: 'Test',
      passwordHash: 'hash',
    })
    .returning();
  return user.id;
}

describe('MonthOverviewService.getOverview', () => {
  it('splits paid/toPay by source (loans, charges, cards) with correct totals', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card, expense, loan } = await seed(db);
      const jun = new Date(Date.UTC(2026, 5, 15));

      // Card config so getBillForMonth can place the fatura.
      await db.insert(creditCardConfigs).values({ accountId: card.id, closingDay: 1, dueDay: 10 });

      await db.insert(transactions).values([
        // PAID loan installment in June (by date).
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: loan.id,
          amount: '700.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela',
          date: jun,
          domainType: 'loan_payment',
          isPaid: true,
        },
        // UNPAID charge (recurring_bill) in June (by date).
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Contador',
          date: jun,
          domainType: 'recurring_bill',
          isPaid: false,
        },
        // PAID card fatura — single installment in June billing, paid.
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela cartão',
          date: jun,
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          isPaid: true,
        },
      ]);

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 45, jun);

      expect(o.paid.loans).toBe(700);
      expect(o.toPay.loans).toBe(0);
      expect(o.paid.charges).toBe(0);
      expect(o.toPay.charges).toBe(200);
      expect(o.paid.cards).toBe(1000);
      expect(o.toPay.cards).toBe(0);
      expect(o.paid.total).toBe(1700);
      expect(o.toPay.total).toBe(200);
    });
  });

  it('splits a partially-paid card fatura into its paid and unpaid portions', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card } = await seed(db);
      const jun = new Date(Date.UTC(2026, 5, 15));

      await db.insert(creditCardConfigs).values({ accountId: card.id, closingDay: 1, dueDay: 10 });

      // Same card, same June billing fatura: one PAID installment (600) and one
      // UNPAID installment (400). The consolidated fatura isPaid===false, but the
      // 600 already settled must land in paid.cards, only the 400 in toPay.cards.
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '600.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela paga',
          date: jun,
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          isPaid: true,
        },
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '400.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela em aberto',
          date: jun,
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          isPaid: false,
        },
      ]);

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 45, jun);

      expect(o.paid.cards).toBe(600);
      expect(o.toPay.cards).toBe(400);
      expect(o.paid.total).toBe(600);
      expect(o.toPay.total).toBe(400);
    });
  });

  it('walletBalance is the canonical real cash of active BRL checking wallets', async () => {
    // Canonical semantics (WalletCashService): walletBalance = Σ over active BRL
    // CHECKING wallets of openingBalance + post-anchor paid movements. Inactive
    // wallets and non-checking accounts (savings/loan) do NOT contribute, and the
    // raw current_balance is irrelevant. This replaces the old raw-current_balance
    // sum (which also counted savings).
    await withRollback(async (db) => {
      const { userId, checking, savings, loan } = await seed(db);
      const asOf = new Date(Date.UTC(2026, 5, 15));
      const anchor = new Date(Date.UTC(2026, 5, 1));
      const accountService = new AccountService(db);
      const inactiveChecking = await accountService.create(userId, {
        name: 'Old Bank',
        type: 'checking',
        currency: 'BRL',
      });
      await accountService.deactivate(userId, inactiveChecking.id);

      // Active checking: opening 700 + a paid post-anchor credit of 300 → 1000.
      await db
        .update(accounts)
        .set({ openingBalance: '700.00', openingBalanceAnchorAt: anchor })
        .where(eq(accounts.id, checking.id));
      await db.insert(transactions).values({
        userId,
        sourceAccountId: loan.id,
        destinationAccountId: checking.id,
        amount: '300.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Crédito',
        date: new Date(Date.UTC(2026, 5, 10)),
        domainType: 'income_clt',
        isPaid: true,
        paidAt: new Date(Date.UTC(2026, 5, 10)),
      });

      // Savings opening balance must NOT count (canonical cash is checking-only).
      await db
        .update(accounts)
        .set({ openingBalance: '500.00', openingBalanceAnchorAt: anchor })
        .where(eq(accounts.id, savings.id));
      // Inactive checking opening balance must NOT count.
      await db
        .update(accounts)
        .set({ openingBalance: '8888.00', openingBalanceAnchorAt: anchor })
        .where(eq(accounts.id, inactiveChecking.id));

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 45, asOf);

      // Only the active BRL checking contributes: 700 opening + 300 paid = 1000.
      expect(o.walletBalance).toBe(1000);
    });
  });

  it('cashToday counts only paid wallet transactions up to asOf', async () => {
    await withRollback(async (db) => {
      const { userId, checking, revenue, expense } = await seed(db);
      const asOf = new Date(Date.UTC(2026, 5, 15));

      await db.insert(transactions).values([
        // PAID deposit into checking before asOf → counts as +5000.
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '5000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário',
          date: new Date(Date.UTC(2026, 5, 10)),
          domainType: 'income_clt',
          isPaid: true,
          paidAt: new Date(Date.UTC(2026, 5, 10)),
        },
        // UNPAID future charge out of checking → must NOT count.
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Conta futura',
          date: new Date(Date.UTC(2026, 5, 20)),
          domainType: 'recurring_bill',
          isPaid: false,
        },
      ]);

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 45, asOf);

      expect(o.cashToday).toBe(5000);
    });
  });

  it('buckets bills under the latest income <= due date and computes both saldos', async () => {
    await withRollback(async (db) => {
      const { userId, checking, revenue, expense } = await seed(db);
      const asOf = new Date(Date.UTC(2026, 5, 1)); // June 1

      // Incomes: 10000 @ Jun 5, 5000 @ Jun 12, 3000 @ Jun 20.
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '10000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Entrada 1',
          date: new Date(Date.UTC(2026, 5, 5)),
          domainType: 'income_clt',
        },
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '5000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Entrada 2',
          date: new Date(Date.UTC(2026, 5, 12)),
          domainType: 'income_clt',
        },
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '3000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Entrada 3',
          date: new Date(Date.UTC(2026, 5, 20)),
          domainType: 'income_clt',
        },
      ]);

      // Bills: 9000 due Jun 8 (period 1), 10000 due Jun 15 (period 2),
      // 1000 due Jun 25 (period 3). Use recurring charges (fixed) so they land
      // in the planner via getUpcomingItems with concrete due days.
      await db.insert(scheduledTransactions).values([
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '9000.00',
          currency: 'BRL',
          description: 'Conta A',
          frequency: 'monthly',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          dueDay: 8,
          domainType: 'recurring_bill',
          isActive: true,
          isFixedCharge: true,
        },
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '10000.00',
          currency: 'BRL',
          description: 'Conta B',
          frequency: 'monthly',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          dueDay: 15,
          domainType: 'recurring_bill',
          isActive: true,
          isFixedCharge: true,
        },
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '1000.00',
          currency: 'BRL',
          description: 'Conta C',
          frequency: 'monthly',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          dueDay: 25,
          domainType: 'recurring_bill',
          isActive: true,
          isFixedCharge: true,
        },
      ]);

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 30, asOf);

      expect(o.periods.length).toBe(3);
      expect(o.periods.map((p) => p.incomeTotal)).toEqual([10000, 5000, 3000]);
      expect(o.periods.map((p) => p.billsTotal)).toEqual([9000, 10000, 1000]);
      expect(o.periods.map((p) => p.saldoDoPeriodo)).toEqual([1000, -5000, 2000]);
      expect(o.periods.map((p) => p.saldoCorrente)).toEqual([1000, -4000, -2000]);
    });
  });

  it('puts a bill due before the first income in a leading null bucket', async () => {
    await withRollback(async (db) => {
      const { userId, checking, revenue, expense } = await seed(db);
      const asOf = new Date(Date.UTC(2026, 5, 1)); // June 1

      // Single income at Jun 20.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: revenue.id,
        destinationAccountId: checking.id,
        amount: '5000.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Entrada',
        date: new Date(Date.UTC(2026, 5, 20)),
        domainType: 'income_clt',
      });

      // A bill due Jun 5 — BEFORE the first income → leading null bucket.
      await db.insert(scheduledTransactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: expense.id,
        amount: '800.00',
        currency: 'BRL',
        description: 'Conta cedo',
        frequency: 'monthly',
        startDate: new Date(Date.UTC(2026, 0, 1)),
        dueDay: 5,
        domainType: 'recurring_bill',
        isActive: true,
        isFixedCharge: true,
      });

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 30, asOf);

      const leading = o.periods[0];
      expect(leading.incomeDate).toBeNull();
      expect(leading.incomeName).toBeNull();
      expect(leading.incomeTotal).toBe(0);
      expect(leading.billsTotal).toBe(800);
      // cashToday is 0 (no paid wallet tx) → leading saldoCorrente = 0 - 800.
      expect(leading.saldoCorrente).toBe(-800);
    });
  });

  it('converts a USD income occurrence to BRL via the income source config rate', async () => {
    await withRollback(async (db) => {
      const { userId, checking } = await seed(db);
      const asOf = new Date(Date.UTC(2026, 5, 1));

      const usdRevenue = await new AccountService(db).create(userId, {
        name: 'USD Salary',
        type: 'revenue',
        currency: 'USD',
      });
      await db.insert(incomeSourceConfigs).values({
        accountId: usdRevenue.id,
        frequency: 'monthly',
        category: 'salary_pj',
        exchangeRate: '5.40',
      });

      // USD income with no per-tx rate → falls back to config (5.40).
      await db.insert(transactions).values({
        userId,
        sourceAccountId: usdRevenue.id,
        destinationAccountId: checking.id,
        amount: '1000.00',
        currency: 'USD',
        type: 'deposit',
        description: 'Salário PJ',
        date: new Date(Date.UTC(2026, 5, 10)),
        domainType: 'income_pj',
      });

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 30, asOf);

      // One income event on Jun 10 worth 1000 * 5.40 = 5400 BRL.
      const event = o.periods.find((p) => p.incomeDate === '2026-06-10');
      expect(event).toBeDefined();
      expect(event?.incomeTotal).toBe(5400);
    });
  });

  it('prefers the per-tx exchange rate over the income source config rate', async () => {
    await withRollback(async (db) => {
      const { userId, checking } = await seed(db);
      const asOf = new Date(Date.UTC(2026, 5, 1));

      const usdRevenue = await new AccountService(db).create(userId, {
        name: 'USD Salary',
        type: 'revenue',
        currency: 'USD',
      });
      // Config rate 5.40, but the received occurrence carries its own 5.00 — the
      // per-tx rate must win (mirrors MonthSummaryService perTxRate ?? configRate).
      await db.insert(incomeSourceConfigs).values({
        accountId: usdRevenue.id,
        frequency: 'monthly',
        category: 'salary_pj',
        exchangeRate: '5.40',
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: usdRevenue.id,
        destinationAccountId: checking.id,
        amount: '1000.00',
        currency: 'USD',
        type: 'deposit',
        description: 'Salário PJ recebido',
        date: new Date(Date.UTC(2026, 5, 10)),
        domainType: 'income_pj',
        exchangeRate: '5.00',
      });

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 30, asOf);

      // 1000 * 5.00 (per-tx) = 5000, NOT 1000 * 5.40 (config) = 5400.
      const event = o.periods.find((p) => p.incomeDate === '2026-06-10');
      expect(event).toBeDefined();
      expect(event?.incomeTotal).toBe(5000);
    });
  });

  it('resolves (not throws) when one income occurrence has no FX rate, omitting it', async () => {
    // BUG 5 regression: one unconvertible projected income must NOT blank the
    // whole monthOverview query. The headline figures and every other period
    // must still resolve; only the rate-less occurrence is dropped from periods.
    await withRollback(async (db) => {
      const { userId, checking, revenue } = await seed(db);
      const asOf = new Date(Date.UTC(2026, 5, 1));

      const usdRevenue = await new AccountService(db).create(userId, {
        name: 'USD Salary',
        type: 'revenue',
        currency: 'USD',
      });
      // No incomeSourceConfigs row and no per-tx exchangeRate → no valid rate.
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: usdRevenue.id,
          destinationAccountId: checking.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'Salário PJ sem taxa',
          date: new Date(Date.UTC(2026, 5, 10)),
          domainType: 'income_pj',
        },
        // A BRL income in the SAME window must still surface as a planner event.
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '3000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário BRL',
          date: new Date(Date.UTC(2026, 5, 15)),
          domainType: 'income_clt',
        },
      ]);

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 30, asOf);

      // The unconvertible USD income is absent (no Jun-10 period).
      expect(o.periods.find((p) => p.incomeDate === '2026-06-10')).toBeUndefined();
      // The BRL income in the same window is present.
      const brlEvent = o.periods.find((p) => p.incomeDate === '2026-06-15');
      expect(brlEvent).toBeDefined();
      expect(brlEvent?.incomeTotal).toBe(3000);
    });
  });

  it('spans EVERY calendar month the planner window touches when loading income', async () => {
    // BUG 1 regression: a 45-day window from Jan 20 reaches into March (≈Mar 6).
    // Bills span every calendar month in the window (via getUpcomingItems), so
    // March income must be loaded too — otherwise a 3rd-month bill is counted
    // without its offsetting income (saldoCorrente understated).
    await withRollback(async (db) => {
      const { userId, checking, revenue, expense } = await seed(db);
      const asOf = new Date(Date.UTC(2026, 0, 20)); // Jan 20 → window ≈ through Mar 6

      // A MARCH income (Mar 3) — must appear as a planner event.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: revenue.id,
        destinationAccountId: checking.id,
        amount: '5000.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Entrada março',
        date: new Date(Date.UTC(2026, 2, 3)),
        domainType: 'income_clt',
      });

      // A MARCH bill (due Mar 4) — falls inside the window via getUpcomingItems.
      await db.insert(scheduledTransactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: expense.id,
        amount: '1200.00',
        currency: 'BRL',
        description: 'Conta março',
        frequency: 'monthly',
        startDate: new Date(Date.UTC(2026, 0, 1)),
        dueDay: 4,
        domainType: 'recurring_bill',
        isActive: true,
        isFixedCharge: true,
      });

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 1, 2026, 45, asOf);

      // The March income event is present and offsets the March bill in its period.
      const marchEvent = o.periods.find((p) => p.incomeDate === '2026-03-03');
      expect(marchEvent).toBeDefined();
      expect(marchEvent?.incomeTotal).toBe(5000);
      expect(marchEvent?.billsTotal).toBe(1200);
      // saldoCorrente reflects BOTH (5000 - 1200 = 3800), not just the -1200 bill.
      expect(marchEvent?.saldoDoPeriodo).toBe(3800);
    });
  });

  it('does not double-count an already-received income (paid, on/before asOf)', async () => {
    // BUG 2 regression: a PAID income dated on/before asOf is already in cashToday;
    // the planner must only project FUTURE (unpaid) income, never re-add it.
    await withRollback(async (db) => {
      const { userId, checking, revenue } = await seed(db);
      const asOf = new Date(Date.UTC(2026, 5, 4, 12, 0, 0));

      await db.insert(transactions).values([
        // PAID income on asOf day → already settled into cashToday.
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '8000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário recebido',
          date: new Date(Date.UTC(2026, 5, 4)),
          domainType: 'income_clt',
          isPaid: true,
          paidAt: new Date(Date.UTC(2026, 5, 4)),
        },
        // UNPAID future income → must still appear as a planner event.
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '2000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário futuro',
          date: new Date(Date.UTC(2026, 5, 20)),
          domainType: 'income_clt',
          isPaid: false,
        },
      ]);

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 45, asOf);

      // The paid 8000 is in cashToday and NOT re-added as a planner period.
      expect(o.cashToday).toBe(8000);
      expect(o.periods.find((p) => p.incomeDate === '2026-06-04')).toBeUndefined();
      // The unpaid future income IS a planner event.
      const future = o.periods.find((p) => p.incomeDate === '2026-06-20');
      expect(future).toBeDefined();
      expect(future?.incomeTotal).toBe(2000);
      // No bills here → saldoCorrente = cashToday(8000) + 2000 = 10000, proving the
      // paid 8000 is counted ONCE.
      expect(future?.saldoCorrente).toBe(10000);
    });
  });

  it('counts the real paid amount of a paid-then-refunded (net-credit) fatura', async () => {
    // BUG 3 regression: a fatura with a PAID installment and a later refund nets
    // to total 0 but has paidTotal 1000 — that real payment must reach paid.cards.
    await withRollback(async (db) => {
      const { userId, checking, card } = await seed(db);
      const jun = new Date(Date.UTC(2026, 5, 15));

      await db.insert(creditCardConfigs).values({ accountId: card.id, closingDay: 1, dueDay: 10 });

      await db.insert(transactions).values([
        // PAID installment of 1000 in June billing.
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela paga',
          date: jun,
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          isPaid: true,
        },
        // 1000 refund landing in the same fatura → total nets to 0.
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Estorno',
          date: jun,
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_refund',
          isPaid: true,
        },
      ]);

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 45, jun);

      expect(o.paid.cards).toBe(1000);
      expect(o.toPay.cards).toBe(0);
    });
  });

  it('ignores a deposit-type row when aggregating loans/charges paid/toPay', async () => {
    // BUG 4 regression: the loan/charge aggregation must match MonthSummaryService's
    // `type IN ('withdrawal','transfer')` constraint — a stray deposit-type row
    // carrying a loan/charge domainType must NOT count as a paid/toPay charge.
    await withRollback(async (db) => {
      const { userId, checking, expense } = await seed(db);
      const jun = new Date(Date.UTC(2026, 5, 15));

      await db.insert(transactions).values({
        userId,
        sourceAccountId: expense.id,
        destinationAccountId: checking.id,
        amount: '300.00',
        currency: 'BRL',
        type: 'deposit', // wrong type for a charge → must be excluded
        description: 'Depósito espúrio',
        date: jun,
        domainType: 'recurring_bill',
        isPaid: false,
      });

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 45, jun);

      expect(o.paid.charges).toBe(0);
      expect(o.toPay.charges).toBe(0);
    });
  });

  it('excludes a non-BRL wallet account from walletBalance and cashToday', async () => {
    // BUG 6 regression: walletBalance/cashToday are BRL figures; a USD checking
    // account must not be summed 1:1 as BRL.
    await withRollback(async (db) => {
      const { userId, checking } = await seed(db);

      const usdChecking = await new AccountService(db).create(userId, {
        name: 'USD Bank',
        type: 'checking',
        currency: 'USD',
      });

      // Express balances via canonical inputs (opening balance) — the USD wallet
      // must be excluded from the BRL canonical cash, not summed 1:1.
      await db
        .update(accounts)
        .set({ openingBalance: '1000.00' })
        .where(eq(accounts.id, checking.id));
      await db
        .update(accounts)
        .set({ openingBalance: '777.00' })
        .where(eq(accounts.id, usdChecking.id));

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 45, new Date(Date.UTC(2026, 5, 15)));

      // Only the BRL checking (1000) counts; the USD 777 is excluded.
      expect(o.walletBalance).toBe(1000);
    });
  });

  it('walletBalance and cashToday both equal anchored real cash', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '-1000.00',
          openingBalanceAnchorAt: new Date('2026-06-01T00:00:00Z'),
        })
        .returning();
      await db.insert(transactions).values({
        userId,
        sourceAccountId: rev.id,
        destinationAccountId: wallet.id,
        amount: '500.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'future salary',
        date: new Date('2026-06-20'),
        domainType: 'income_clt',
        isPaid: false,
      });

      const overview = await new MonthOverviewService(db).getOverview(
        userId,
        6,
        2026,
        45,
        new Date('2026-06-04'),
      );
      expect(overview.walletBalance).toBeCloseTo(-1000, 2);
      expect(overview.cashToday).toBeCloseTo(-1000, 2);
    });
  });

  it('planner does NOT project a family expected receipt (family payments are partial)', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const asOf = new Date(2026, 5, 15); // local June 15

      const flow = new FamilyLoanFlowService(db);
      const { config } = await flow.createFamilyLoan(userId, {
        personName: 'Maria',
        receiptDay: 20,
      });
      // An owed charge for the CURRENT month with NO payment → still owed 1500.
      await flow.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Empréstimo',
        amount: '1500.00',
        date: new Date(Date.UTC(2026, 5, 1)),
        billingMonth: 6,
        billingYear: 2026,
      });

      const svc = new MonthOverviewService(db);
      const o = await svc.getOverview(userId, 6, 2026, 45, asOf);

      // The owed remainder is NO LONGER projected as a planner income event:
      // family-loan payments are partial and only count once actually received
      // (into cashToday). No income period is opened for the person.
      expect(o.periods.some((p) => p.incomeName === 'Maria')).toBe(false);
    });
  });
});
