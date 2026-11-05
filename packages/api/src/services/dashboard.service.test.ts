import type { DbExecutor } from '@fc/db';
import {
  creditCardConfigs,
  loanConfigs,
  scheduledTransactions,
  transactions,
  userProfiles,
} from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createCardWriteContext } from '../lib/card-write-context.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { DashboardService } from './dashboard.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { TransactionService } from './transaction.service.ts';

const QUERY_VERBS = new Set(['select', 'insert', 'update', 'delete', 'execute']);

/**
 * Transparent counting proxy over the real DbExecutor (not a mock: every call
 * reaches the database). It counts query-builder entry points, which map 1:1
 * to SQL statements in the read paths covered here.
 */
function withQueryCounter(db: DbExecutor): { counted: DbExecutor; queries: () => number } {
  let n = 0;
  const counted = new Proxy(db, {
    get(target, prop) {
      if (typeof prop === 'string' && QUERY_VERBS.has(prop)) n += 1;
      const value: unknown = Reflect.get(target, prop);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  });
  return { counted, queries: () => n };
}

async function seedDashboard(db: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'dashboard-summary@test.com', name: 'Test', passwordHash: 'hash' })
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

async function seed(db: DbExecutor, email = 'dashboard@test.com') {
  const accountService = new AccountService(db);
  const txService = new TransactionService(db);
  const dashService = new DashboardService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({ email, name: 'Test', passwordHash: 'hash' })
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
  const cc = await accountService.create(userId, {
    name: 'Nubank',
    type: 'credit_card',
    currency: 'BRL',
  });

  return {
    txService,
    dashService,
    userId,
    checkingId: checking.id,
    expenseId: expense.id,
    revenueId: revenue.id,
    creditCardId: cc.id,
  };
}

describe('DashboardService', () => {
  describe('getMonthlySummary', () => {
    it('calculates income and expenses for a month (billing-month semantics)', async () => {
      await withRollback(async (db) => {
        const { dashService, userId, checkingId, expenseId, revenueId, creditCardId } =
          await seed(db);

        await db.insert(transactions).values([
          {
            userId,
            sourceAccountId: revenueId,
            destinationAccountId: checkingId,
            amount: '8000.00',
            currency: 'BRL',
            type: 'deposit',
            description: 'Salary',
            date: new Date(2026, 2, 5),
            domainType: 'income_clt',
          },
          {
            userId,
            sourceAccountId: expenseId,
            destinationAccountId: creditCardId,
            amount: '500.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Groceries',
            date: new Date(2026, 2, 10),
            billingMonth: 3,
            billingYear: 2026,
            domainType: 'credit_card_installment',
          },
        ]);

        const summary = await dashService.getMonthlySummary(userId, 3, 2026);

        expect(summary.income).toBe(8000);
        expect(summary.expenses).toBe(500);
        expect(summary.balance).toBe(7500);
        expect('savingsRate' in summary).toBe(false);
      });
    });

    it('returns zeros for month with no transactions', async () => {
      await withRollback(async (db) => {
        const { dashService, userId } = await seed(db);
        const summary = await dashService.getMonthlySummary(userId, 6, 2026);

        expect(summary.income).toBe(0);
        expect(summary.expenses).toBe(0);
        expect(summary.balance).toBe(0);
        expect('savingsRate' in summary).toBe(false);
      });
    });

    it('excludes reversed transactions', async () => {
      await withRollback(async (db) => {
        const { txService, dashService, userId, expenseId, creditCardId } = await seed(db);
        const tx = await txService.createWithinCardFlow(createCardWriteContext(userId), userId, {
          sourceAccountId: expenseId,
          destinationAccountId: creditCardId,
          amount: '500.00',
          description: 'To reverse',
          date: new Date(2026, 2, 10),
        });

        await txService.reverse(userId, tx.id);

        const summary = await dashService.getMonthlySummary(userId, 3, 2026);
        expect(summary.expenses).toBe(0);
      });
    });
  });

  describe('getCashFlow', () => {
    it('returns array of monthly summaries', async () => {
      await withRollback(async (db) => {
        const { dashService, userId } = await seed(db);
        const cashFlow = await dashService.getCashFlow(userId, 3);

        expect(cashFlow).toHaveLength(3);
        expect(cashFlow[0]).toHaveProperty('month');
        expect(cashFlow[0]).toHaveProperty('income');
        expect(cashFlow[0]).toHaveProperty('expenses');
      });
    });

    it('months equal getMonthlySummary for the same month (equivalence regression)', async () => {
      await withRollback(async (db) => {
        const { dashService, userId, checkingId, expenseId, revenueId, creditCardId } =
          await seed(db);
        const now = new Date();

        await db.insert(transactions).values([
          {
            userId,
            sourceAccountId: revenueId,
            destinationAccountId: checkingId,
            amount: '8000.00',
            currency: 'BRL',
            type: 'deposit',
            description: 'Salary',
            date: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 5)),
            domainType: 'income_clt',
          },
          {
            userId,
            sourceAccountId: expenseId,
            destinationAccountId: creditCardId,
            amount: '500.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Groceries',
            date: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 10)),
            billingMonth: now.getMonth() + 1,
            billingYear: now.getFullYear(),
            domainType: 'credit_card_installment',
          },
        ]);

        const flow = new FamilyLoanFlowService(db);
        const { config } = await flow.createFamilyLoan(userId, { personName: 'Célia' });
        await flow.addFixedCharge(userId, {
          configId: config.id,
          description: 'Mensalidade fixa',
          amount: '500.00',
          startDate: new Date(Date.UTC(now.getFullYear(), now.getMonth() - 2, 14)),
          dueDay: 14,
        });

        const cashFlow = await dashService.getCashFlow(userId, 3);
        expect(cashFlow).toHaveLength(3);
        for (const row of cashFlow) {
          const direct = await dashService.getMonthlySummary(userId, row.month, row.year);
          expect(row.income, `income mismatch ${row.year}-${row.month}`).toBeCloseTo(
            direct.income,
            2,
          );
          expect(row.expenses, `expenses mismatch ${row.year}-${row.month}`).toBeCloseTo(
            direct.expenses,
            2,
          );
          expect(row.balance, `balance mismatch ${row.year}-${row.month}`).toBeCloseTo(
            direct.balance,
            2,
          );
        }
      });
    });

    it('batches family-loan owed: added months have the same query growth with many configs/cards', async () => {
      await withRollback(async (db) => {
        const { userId } = await seed(db, 'dashboard-complexity-complex@test.com');
        const flow = new FamilyLoanFlowService(db);
        const now = new Date();

        for (const name of ['Célia', 'João']) {
          const { config } = await flow.createFamilyLoan(userId, { personName: name });
          await flow.addFixedCharge(userId, {
            configId: config.id,
            description: `Mensalidade ${name}`,
            amount: '300.00',
            startDate: new Date(Date.UTC(now.getFullYear(), now.getMonth() - 5, 10)),
            dueDay: 10,
          });
          if (name === 'Célia') {
            const accountService = new AccountService(db);
            const card = await accountService.create(userId, {
              name: `Cartão ${name}`,
              type: 'credit_card',
              currency: 'BRL',
            });
            await flow.addBorrowedCard(userId, {
              configId: config.id,
              creditCardAccountId: card.id,
            });
          }
        }

        const measure = async (id: string, months: number) => {
          const { counted, queries } = withQueryCounter(db);
          const rows = await new DashboardService(counted).getCashFlow(id, months);
          expect(rows).toHaveLength(months);
          return queries();
        };

        const simple = await seed(db, 'dashboard-complexity-simple@test.com');
        const simpleThree = await measure(simple.userId, 3);
        const simpleTwelve = await measure(simple.userId, 12);
        const complexThree = await measure(userId, 3);
        const complexTwelve = await measure(userId, 12);

        expect(complexThree).toBeGreaterThan(simpleThree);
        expect(complexTwelve - complexThree).toBe(simpleTwelve - simpleThree);
      });
    });
  });
});

describe('DashboardService.getMonthlySummary (delegates to MonthSummaryService)', () => {
  it('returns income=totalIncome and expenses=totalExpenses, without savingsRate', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card } = await seedDashboard(db);
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: card.id,
        amount: '1000.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Parcela',
        date: new Date(2026, 5, 10),
        billingMonth: 6,
        billingYear: 2026,
        domainType: 'credit_card_installment',
      });
      const result = await new DashboardService(db).getMonthlySummary(userId, 6, 2026);
      expect(result.expenses).toBe(1000);
      expect(result.income).toBe(0);
      expect(result.balance).toBe(-1000);
      expect('savingsRate' in result).toBe(false);
    });
  });
});

describe('DashboardService.getUpcomingItems (aggregated)', () => {
  // `getBillSummary` derives its window from the real `new Date()`, so we anchor
  // the deterministic `asOf` to the same instant and pick a due day that is
  // guaranteed to fall inside [today, today+30] within the current calendar month.
  const asOf = new Date();
  const dueDayWithinWindow = () => {
    const today = asOf.getDate();
    const lastDayOfMonth = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 0).getDate();
    // today+2 stays in the future and within 30 days; clamp to the month end.
    return Math.min(today + 2, lastDayOfMonth);
  };
  const currentBillingMonthYear = () => ({ m: asOf.getMonth() + 1, y: asOf.getFullYear() });

  it('returns one card item per card (fatura), no raw installments, no income', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card, revenue } = await seedDashboard(db);
      // a card config with a dueDay near today; two installments same fatura
      await db
        .insert(creditCardConfigs)
        .values({ accountId: card.id, closingDay: 1, dueDay: dueDayWithinWindow() });
      const billMonthYear = currentBillingMonthYear();
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'P1',
          date: asOf,
          billingMonth: billMonthYear.m,
          billingYear: billMonthYear.y,
          domainType: 'credit_card_installment',
          installmentNumber: 1,
          totalInstallments: 3,
        },
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'P2',
          date: asOf,
          billingMonth: billMonthYear.m,
          billingYear: billMonthYear.y,
          domainType: 'credit_card_installment',
          installmentNumber: 1,
          totalInstallments: 3,
        },
        // an income deposit in window — must NOT appear in upcoming
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '5000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário',
          date: asOf,
          domainType: 'income_clt',
        },
      ]);

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const cards = items.filter((i) => i.kind === 'card');
      expect(cards.length).toBe(1);
      expect(cards[0].amount).toBe(200); // whole fatura
      expect(items.some((i) => (i.kind as string) === 'income')).toBe(false);
      expect(items.every((i) => !('installmentNumber' in i))).toBe(true);
    });
  });

  // GAP-1: a PARTIALLY-paid fatura must emit only its still-owed remainder
  // (unpaidTotal), not the gross total. The planner running balance starts from
  // real cash, so emitting the full total double-subtracts the already-paid
  // portion. One charge 600 paid + one charge 400 unpaid → total=1000,
  // paidTotal=600, unpaidTotal=400. The emitted card amount must be 400, not 1000.
  // This assertion genuinely depends on unpaidTotal !== total.
  it('emits only the unpaid remainder for a partially-paid card fatura', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card } = await seedDashboard(db);
      await db
        .insert(creditCardConfigs)
        .values({ accountId: card.id, closingDay: 1, dueDay: dueDayWithinWindow() });
      const billMonthYear = currentBillingMonthYear();
      await db.insert(transactions).values([
        // Already-paid charge (600) → counts toward paidTotal.
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '600.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Paga',
          date: asOf,
          billingMonth: billMonthYear.m,
          billingYear: billMonthYear.y,
          domainType: 'credit_card_installment',
          isPaid: true,
          isReversed: false,
        },
        // Still-owed charge (400) → the only amount that must reach the planner.
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '400.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Em aberto',
          date: asOf,
          billingMonth: billMonthYear.m,
          billingYear: billMonthYear.y,
          domainType: 'credit_card_installment',
          isPaid: false,
          isReversed: false,
        },
      ]);

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const cards = items.filter((i) => i.kind === 'card');
      expect(cards.length).toBe(1);
      // total=1000, paidTotal=600 → unpaidTotal=400. Must NOT be the gross 1000.
      expect(cards[0].amount).toBe(400);
      expect(cards[0].amount).not.toBe(1000);
    });
  });

  it('spans into next month for a fixed charge due early next month within the window', async () => {
    await withRollback(async (db) => {
      const { userId, checking, expense } = await seedDashboard(db);
      // asOf late in June; a 30-day window reaches into July.
      const lateJune = new Date(2026, 5, 25);
      // Active monthly recurring_bill with dueDay=3 → next occurrence is 2026-07-03.
      await db.insert(scheduledTransactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: expense.id,
        amount: '200.00',
        currency: 'BRL',
        description: 'Contador',
        frequency: 'monthly',
        startDate: new Date(2026, 0, 1),
        dueDay: 3,
        domainType: 'recurring_bill',
        isActive: true,
        isFixedCharge: true,
      });

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, lateJune);
      const charges = items.filter((i) => i.kind === 'fixed_charge');
      expect(charges.map((c) => c.dueDate)).toContain('2026-07-03');
      // The past June occurrence (2026-06-03) is before `today` and must be excluded.
      expect(charges.map((c) => c.dueDate)).not.toContain('2026-06-03');
      expect(charges.every((c) => c.amount === 200)).toBe(true);
    });
  });

  // Bug C4: card faturas due early next month must appear when the window
  // crosses a month boundary. getBillSummary is hard-wired to the current
  // calendar month, so getUpcomingItems must span months for cards too.
  it('spans into next month for a card fatura due early next month within the window', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card } = await seedDashboard(db);
      // asOf late in June; a 30-day window reaches into July (up to 2026-07-25).
      const lateJune = new Date(2026, 5, 25);
      // Card due day 10 → the July fatura is due 2026-07-10, inside the window.
      await db.insert(creditCardConfigs).values({ accountId: card.id, closingDay: 1, dueDay: 10 });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: card.id,
        amount: '300.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Parcela julho',
        date: new Date(2026, 6, 5),
        billingMonth: 7,
        billingYear: 2026,
        domainType: 'credit_card_installment',
      });

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, lateJune);
      const cards = items.filter((i) => i.kind === 'card');
      // Before the fix this fatura was invisible (getBillSummary only looks at June).
      const july = cards.find((c) => c.dueDate === '2026-07-10');
      expect(july).toBeDefined();
      expect(july?.amount).toBe(300);
      expect(july?.isPaid).toBe(false);
    });
  });

  // R10b: a card whose dueDay <= closingDay is DUE the calendar month AFTER its
  // billingMonth (computeFaturaDueDate). Its June fatura (closes June 28) is due
  // 2026-07-03 — so with asOf late June and a 30-day window it must appear dated
  // 2026-07-03, NOT 2026-06-03. The candidate-billing-month set must include the
  // month BEFORE the window (June here) so this next-month-due fatura is found.
  it('places a next-month-due card fatura (dueDay<=closingDay) on its real due date', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card } = await seedDashboard(db);
      const lateJune = new Date(2026, 5, 25); // 2026-06-25; window reaches 2026-07-25
      // closingDay 28, dueDay 3 → dueDay <= closingDay → due the month AFTER
      // billingMonth. The June fatura (billingMonth=6) is due 2026-07-03.
      await db.insert(creditCardConfigs).values({ accountId: card.id, closingDay: 28, dueDay: 3 });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: card.id,
        amount: '500.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Parcela junho',
        date: new Date(2026, 5, 10),
        billingMonth: 6,
        billingYear: 2026,
        domainType: 'credit_card_installment',
      });

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, lateJune);
      const cards = items.filter((i) => i.kind === 'card');
      // Exactly one card item, on the REAL due date (next month), not 2026-06-03.
      expect(cards.length).toBe(1);
      expect(cards[0].dueDate).toBe('2026-07-03');
      expect(cards[0].amount).toBe(500);
      expect(cards.some((c) => c.dueDate === '2026-06-03')).toBe(false);
    });
  });

  // Upcoming is a FUTURE window [asOf, asOf+days]. A fatura or charge whose due
  // date is in the PAST (before asOf, outside the window) is overdue/settled
  // territory and must NOT surface as an upcoming alert. Lock the future-window
  // boundary for BOTH a card fatura and a fixed charge with a deterministic asOf.
  it('excludes a card fatura and a fixed charge whose due date is in the past', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card, expense } = await seedDashboard(db);
      const asOf = new Date(2026, 5, 20); // 2026-06-20

      // Card fatura due 2026-06-05 — before asOf, so outside [asOf, asOf+30].
      await db.insert(creditCardConfigs).values({ accountId: card.id, closingDay: 1, dueDay: 5 });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: card.id,
        amount: '400.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Parcela junho',
        date: new Date(2026, 4, 28),
        billingMonth: 6,
        billingYear: 2026,
        domainType: 'credit_card_installment',
      });

      // Fixed charge with dueDay=3 → June occurrence is 2026-06-03, also in the past.
      await db.insert(scheduledTransactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: expense.id,
        amount: '150.00',
        currency: 'BRL',
        description: 'Contador',
        frequency: 'monthly',
        startDate: new Date(2026, 0, 1),
        dueDay: 3,
        domainType: 'recurring_bill',
        isActive: true,
        isFixedCharge: true,
      });

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);

      // The past June card fatura (due 2026-06-05) is excluded.
      expect(items.some((i) => i.kind === 'card' && i.dueDate === '2026-06-05')).toBe(false);
      // The past June charge occurrence (due 2026-06-03) is excluded.
      expect(items.some((i) => i.kind === 'fixed_charge' && i.dueDate === '2026-06-03')).toBe(
        false,
      );
      // Every surviving item is dated on/after asOf (no overdue leakage).
      expect(items.every((i) => i.dueDate >= '2026-06-20')).toBe(true);
    });
  });

  // Bug H9: a one-time charge whose materialized occurrence is already paid
  // must report isPaid:true (was hard-coded false).
  it('reflects the real paid state of a one-time charge', async () => {
    await withRollback(async (db) => {
      const { userId, checking, expense } = await seedDashboard(db);
      const asOf = new Date(2026, 5, 10);
      const dueDate = new Date(2026, 5, 15); // within the 30-day window
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '120.00',
          currency: 'BRL',
          description: 'IPTU',
          frequency: 'once',
          startDate: dueDate,
          domainType: 'recurring_bill',
          isActive: true,
        })
        .returning();
      // The materialized occurrence, already settled.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: expense.id,
        amount: '120.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'IPTU',
        date: dueDate,
        domainType: 'recurring_bill',
        scheduledTransactionId: schedule.id,
        isPaid: true,
        isReversed: false,
      });

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const oneTime = items.find((i) => i.kind === 'one_time_charge' && i.id === schedule.id);
      expect(oneTime).toBeDefined();
      expect(oneTime?.isPaid).toBe(true);
    });
  });

  // Due-day rollover: a fixed charge with dueDay=31 in a 30-day month (June)
  // must land on the clamped month-end (2026-06-30), NOT roll over into the
  // following month (2026-07-01), which would mis-bucket it in the planner.
  it('clamps a fixed-charge dueDay past the month length to the month end (no rollover)', async () => {
    await withRollback(async (db) => {
      const { userId, checking, expense } = await seedDashboard(db);
      const asOf = new Date(2026, 5, 10); // 2026-06-10; window reaches 2026-07-10
      await db.insert(scheduledTransactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: expense.id,
        amount: '80.00',
        currency: 'BRL',
        description: 'Conta dia 31',
        frequency: 'monthly',
        startDate: new Date(2026, 0, 1),
        dueDay: 31,
        domainType: 'recurring_bill',
        isActive: true,
        isFixedCharge: true,
      });

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const charges = items.filter((i) => i.kind === 'fixed_charge');
      // June has 30 days → clamp 31 to 30 → 2026-06-30, never 2026-07-01.
      expect(charges.map((c) => c.dueDate)).toContain('2026-06-30');
      expect(charges.map((c) => c.dueDate)).not.toContain('2026-07-01');
    });
  });

  // Due-day rollover (loan): a loan with dueDay=31 in a 30-day month (June) must
  // land on the clamped month-end (2026-06-30), NOT roll over into July (07-01).
  it('clamps a loan dueDay past the month length to the month end (no rollover)', async () => {
    await withRollback(async (db) => {
      const { userId, checking, loan } = await seedDashboard(db);
      const asOf = new Date(2026, 5, 10); // 2026-06-10; window reaches 2026-07-10
      await db.insert(loanConfigs).values({
        accountId: loan.id,
        loanCategory: 'bank',
        loanType: 'consignado',
        totalInstallments: 12,
        monthlyPayment: '500.00',
        dueDay: 31,
        monthlyInterestRate: '0.01',
      });
      // A non-reversed loan_payment due this month → computeCurrentInstallment > 0
      // so the loan surfaces as an upcoming item.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: loan.id,
        amount: '500.00',
        currency: 'BRL',
        type: 'transfer',
        description: 'Parcela',
        date: new Date(2026, 5, 30),
        domainType: 'loan_payment',
        installmentNumber: 3,
        isPaid: false,
        isReversed: false,
      });

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const loans = items.filter((i) => i.kind === 'loan' && i.id === loan.id);
      // June has 30 days → clamp 31 to 30 → 2026-06-30, never 2026-07-01.
      expect(loans.map((l) => l.dueDate)).toContain('2026-06-30');
      expect(loans.map((l) => l.dueDate)).not.toContain('2026-07-01');
    });
  });

  // Due-day rollover (February): a fixed_charge with dueDay=31 in a non-leap
  // February (2026) must land on the clamped month-end (2026-02-28), never
  // spill into March.
  it('clamps a fixed-charge dueDay=31 in non-leap February to 2026-02-28', async () => {
    await withRollback(async (db) => {
      const { userId, checking, expense } = await seedDashboard(db);
      const asOf = new Date(2026, 1, 10); // 2026-02-10; window reaches 2026-03-12
      await db.insert(scheduledTransactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: expense.id,
        amount: '80.00',
        currency: 'BRL',
        description: 'Conta dia 31',
        frequency: 'monthly',
        startDate: new Date(2026, 0, 1),
        dueDay: 31,
        domainType: 'recurring_bill',
        isActive: true,
        isFixedCharge: true,
      });

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const charges = items.filter((i) => i.kind === 'fixed_charge');
      // 2026 is not a leap year → February has 28 days → clamp 31 to 28.
      expect(charges.map((c) => c.dueDate)).toContain('2026-02-28');
      expect(charges.map((c) => c.dueDate)).not.toContain('2026-02-29');
      expect(charges.map((c) => c.dueDate)).not.toContain('2026-03-01');
    });
  });

  // Task 1 — `card` items carry the fatura's billing month/year so the web
  // client can route `creditCard.payBill({ month, year })`.
  it('exposes numeric billingMonth/billingYear on card items', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card } = await seedDashboard(db);
      const billMonthYear = currentBillingMonthYear();
      await db
        .insert(creditCardConfigs)
        .values({ accountId: card.id, closingDay: 1, dueDay: dueDayWithinWindow() });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: card.id,
        amount: '100.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'P1',
        date: asOf,
        billingMonth: billMonthYear.m,
        billingYear: billMonthYear.y,
        domainType: 'credit_card_installment',
      });

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const cardItem = items.find((i) => i.kind === 'card' && i.id === card.id);
      expect(cardItem).toBeDefined();
      expect(cardItem?.billingMonth).toBe(billMonthYear.m);
      expect(cardItem?.billingYear).toBe(billMonthYear.y);
    });
  });

  // Task 1 — a one_time_charge exposes the id of its materialized transaction so
  // the web client can route `charges.markOccurrenceAsPaid({ transactionId })`.
  it('exposes transactionId on a one_time_charge from its materialized tx', async () => {
    await withRollback(async (db) => {
      const { userId, checking, expense } = await seedDashboard(db);
      const asOf = new Date(2026, 5, 10);
      const dueDate = new Date(2026, 5, 15);
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '120.00',
          currency: 'BRL',
          description: 'IPTU',
          frequency: 'once',
          startDate: dueDate,
          domainType: 'recurring_bill',
          isActive: true,
        })
        .returning();
      const [_materialized] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '120.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'IPTU',
          date: dueDate,
          domainType: 'recurring_bill',
          scheduledTransactionId: schedule.id,
          isPaid: false,
          isReversed: false,
        })
        .returning();

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const oneTime = items.find((i) => i.kind === 'one_time_charge' && i.id === schedule.id);
      expect(oneTime).toBeDefined();
      expect(oneTime?.transactionId).toBeDefined();
      const [actualMaterialized] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, oneTime?.transactionId ?? ''));
      expect(actualMaterialized?.scheduledTransactionId).toBe(schedule.id);
    });
  });

  // Task 1 (bug fix) — a fixed_charge whose in-window occurrence is paid must
  // report isPaid:true AND expose the materialized tx id (was hard-coded false).
  it('reports a paid fixed_charge occurrence as isPaid:true with transactionId', async () => {
    await withRollback(async (db) => {
      const { userId, checking, expense } = await seedDashboard(db);
      const asOf = new Date(2026, 5, 10);
      const occurrenceDate = new Date(2026, 5, 12); // within the 30-day window
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '200.00',
          currency: 'BRL',
          description: 'Contador',
          frequency: 'monthly',
          startDate: new Date(2026, 0, 1),
          dueDay: 12,
          domainType: 'recurring_bill',
          isActive: true,
          isFixedCharge: true,
        })
        .returning();
      const [materialized] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Contador',
          date: occurrenceDate,
          domainType: 'recurring_bill',
          scheduledTransactionId: schedule.id,
          isPaid: true,
          isReversed: false,
        })
        .returning();

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const fixed = items.find((i) => i.kind === 'fixed_charge' && i.id === schedule.id);
      expect(fixed).toBeDefined();
      expect(fixed?.isPaid).toBe(true);
      expect(fixed?.transactionId).toBe(materialized.id);
    });
  });

  // Task 1 — defensive branch of `findMaterializedCharge`: when the in-window
  // occurrence has NO schedule-linked (`scheduledTransactionId`) materialized
  // row, the helper returns null and the item keeps isPaid:false with
  // transactionId undefined (no crash). Reproduced on the `once` charge path
  // (shares the same helper) with a MANUAL reconciliation row
  // (scheduledTransactionId = NULL): its content fingerprint matches the single
  // occurrence, so the MaterializationGuard's materializer skips creating a
  // linked row — leaving only the unlinked manual one, invisible to the helper.
  it('leaves transactionId undefined for a charge with no schedule-linked occurrence', async () => {
    await withRollback(async (db) => {
      const { userId, checking, expense } = await seedDashboard(db);
      const asOf = new Date(2026, 5, 10);
      const dueDate = new Date(2026, 5, 15); // within the 30-day window
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '200.00',
          currency: 'BRL',
          description: 'IPTU',
          frequency: 'once',
          startDate: dueDate,
          domainType: 'recurring_bill',
          isActive: true,
        })
        .returning();
      // Manual reconciliation row: NULL scheduledTransactionId, same content key
      // (source/dest/amount/domainType; billing & installment NULL for a non-card
      // recurring_bill). The materializer treats it as covering the single
      // occurrence and does not insert a schedule-linked duplicate.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: expense.id,
        amount: '200.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'IPTU',
        date: dueDate,
        domainType: 'recurring_bill',
        scheduledTransactionId: null,
        isPaid: false,
        isReversed: false,
      });

      const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const charge = items.find((i) => i.kind === 'one_time_charge' && i.id === schedule.id);
      expect(charge).toBeDefined();
      expect(charge?.isPaid).toBe(false);
      expect(charge?.transactionId).toBeUndefined();
    });
  });

  // Batching regression guard: the per-loan installment state (current = MAX
  // installment_number through the month; isPaid = no unpaid installment through
  // the month) is now computed in-memory from a single batched loan_payment
  // query. With MULTIPLE installment rows for the SAME loan, the in-memory MAX
  // must pick the highest installment (surfacing the loan) and the unpaid scan
  // must reflect the true paid-state. A loan whose due installment is fully PAID
  // reports isPaid:true; an unpaid one reports false. A naive batching bug
  // (wrong grouping, COUNT-vs-MAX, or inverted paid check) would flip these.
  it('computes loan installment state correctly from batched rows (multi-installment, paid vs unpaid)', async () => {
    await withRollback(async (db) => {
      const { userId, checking, loan } = await seedDashboard(db);
      const asOf = new Date(2026, 5, 10); // 2026-06-10; window reaches 2026-07-10
      await db.insert(loanConfigs).values({
        accountId: loan.id,
        loanCategory: 'bank',
        loanType: 'consignado',
        totalInstallments: 12,
        monthlyPayment: '500.00',
        dueDay: 15, // 2026-06-15 is in-window
        monthlyInterestRate: '0.01',
      });
      // Three installments through June, ALL paid → current = MAX(3) > 0 (loan
      // surfaces) and there is NO unpaid installment through June → isPaid:true.
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: loan.id,
          amount: '500.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'Parcela 1',
          date: new Date(2026, 3, 15),
          domainType: 'loan_payment',
          installmentNumber: 1,
          isPaid: true,
          isReversed: false,
        },
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: loan.id,
          amount: '500.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'Parcela 2',
          date: new Date(2026, 4, 15),
          domainType: 'loan_payment',
          installmentNumber: 2,
          isPaid: true,
          isReversed: false,
        },
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: loan.id,
          amount: '500.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'Parcela 3',
          date: new Date(2026, 5, 5),
          domainType: 'loan_payment',
          installmentNumber: 3,
          isPaid: true,
          isReversed: false,
        },
      ]);

      const paidItems = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const paidLoan = paidItems.find((i) => i.kind === 'loan' && i.id === loan.id);
      expect(paidLoan).toBeDefined();
      expect(paidLoan?.dueDate).toBe('2026-06-15');
      expect(paidLoan?.amount).toBe(500);
      expect(paidLoan?.isPaid).toBe(true);

      // Add a fourth, UNPAID installment also due through June → the unpaid scan
      // now finds an unpaid row through the month → isPaid flips to false, while
      // current = MAX(4) keeps the loan surfaced.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: loan.id,
        amount: '500.00',
        currency: 'BRL',
        type: 'transfer',
        description: 'Parcela 4',
        date: new Date(2026, 5, 8),
        domainType: 'loan_payment',
        installmentNumber: 4,
        isPaid: false,
        isReversed: false,
      });

      const unpaidItems = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);
      const unpaidLoan = unpaidItems.find((i) => i.kind === 'loan' && i.id === loan.id);
      expect(unpaidLoan).toBeDefined();
      expect(unpaidLoan?.isPaid).toBe(false);
    });
  });

  // TZ regression: the charge-occurrence index keys by calendar month. The
  // `transactions.date` column is UTC-midnight, so deriving the row's month with
  // LOCAL getters in a negative-offset TZ (UTC−3) reads a FIRST-of-month date as
  // the PREVIOUS month, mis-keying it vs the lookup → a PAID first-of-month charge
  // is reported isPaid:false / transactionId:undefined (false unpaid alert, no
  // mark-paid button). The fix keys both sides from UTC/loop integers, so this
  // passes in any TZ. We pin TZ to America/Sao_Paulo so this also fails-without-fix
  // on a UTC CI runner. Covers BOTH the one-time (startDate on the 1st) and fixed
  // (dueDay:1) charge paths.
  it('reports a PAID first-of-month charge as isPaid:true in a negative-offset TZ (UTC−3)', async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/Sao_Paulo';
    try {
      await withRollback(async (db) => {
        const { userId, checking, expense } = await seedDashboard(db);
        const asOf = new Date(2026, 5, 20); // 2026-06-20; window reaches 2026-07-20
        const firstOfJuly = new Date(2026, 6, 1); // stored UTC-midnight 2026-07-01

        // (1) One-time charge with startDate on the 1st, materialized + PAID.
        const [oneTimeSchedule] = await db
          .insert(scheduledTransactions)
          .values({
            userId,
            sourceAccountId: checking.id,
            destinationAccountId: expense.id,
            amount: '120.00',
            currency: 'BRL',
            description: 'IPTU dia 1',
            frequency: 'once',
            startDate: firstOfJuly,
            domainType: 'recurring_bill',
            isActive: true,
          })
          .returning();
        const [oneTimeTx] = await db
          .insert(transactions)
          .values({
            userId,
            sourceAccountId: checking.id,
            destinationAccountId: expense.id,
            amount: '120.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'IPTU dia 1',
            date: firstOfJuly,
            domainType: 'recurring_bill',
            scheduledTransactionId: oneTimeSchedule.id,
            isPaid: true,
            isReversed: false,
          })
          .returning();

        // (2) Fixed monthly charge due on the 1st, July occurrence materialized + PAID.
        const [fixedSchedule] = await db
          .insert(scheduledTransactions)
          .values({
            userId,
            sourceAccountId: checking.id,
            destinationAccountId: expense.id,
            amount: '200.00',
            currency: 'BRL',
            description: 'Aluguel dia 1',
            frequency: 'monthly',
            startDate: new Date(2026, 0, 1),
            dueDay: 1,
            domainType: 'recurring_bill',
            isActive: true,
            isFixedCharge: true,
          })
          .returning();
        const [fixedTx] = await db
          .insert(transactions)
          .values({
            userId,
            sourceAccountId: checking.id,
            destinationAccountId: expense.id,
            amount: '200.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Aluguel dia 1',
            date: firstOfJuly,
            domainType: 'recurring_bill',
            scheduledTransactionId: fixedSchedule.id,
            isPaid: true,
            isReversed: false,
          })
          .returning();

        const items = await new DashboardService(db).getUpcomingItems(userId, 30, asOf);

        // One-time first-of-month occurrence: the regression is the PAID-state
        // lookup (occKey match), so assert isPaid/transactionId — the exact dueDate
        // STRING is a separate pre-existing local-vs-UTC rendering concern out of
        // scope here. Before the fix these were false/undefined (mis-keyed month).
        const oneTime = items.find(
          (i) => i.kind === 'one_time_charge' && i.id === oneTimeSchedule.id,
        );
        expect(oneTime).toBeDefined();
        expect(oneTime?.isPaid).toBe(true);
        expect(oneTime?.transactionId).toBe(oneTimeTx.id);

        // Fixed July-1 occurrence in-window (dueDate built local → 2026-07-01),
        // must be found as paid with its tx id. Before the fix the row (UTC-July)
        // was keyed June while the lookup keyed July → not found → isPaid:false.
        const fixed = items.find(
          (i) =>
            i.kind === 'fixed_charge' && i.id === fixedSchedule.id && i.dueDate === '2026-07-01',
        );
        expect(fixed).toBeDefined();
        expect(fixed?.isPaid).toBe(true);
        expect(fixed?.transactionId).toBe(fixedTx.id);
      });
    } finally {
      process.env.TZ = originalTz;
    }
  });
});
