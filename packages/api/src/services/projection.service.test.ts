import type { DbExecutor } from '@fc/db';
import { incomeSourceConfigs, transactions, userProfiles } from '@fc/db';
import type { DomainType } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { MaterializationGuard } from './materialization-guard.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';
import { ProjectionService } from './projection.service.ts';
import { ScheduledService } from './scheduled.service.ts';
import { TransactionService } from './transaction.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const txService = new TransactionService(db);
  const projectionService = new ProjectionService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'projection@test.com', name: 'Test', passwordHash: 'hash' })
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
  const loan = await accountService.create(userId, { name: 'Loan', type: 'loan', currency: 'BRL' });

  return {
    txService,
    projectionService,
    userId,
    checkingId: checking.id,
    expenseId: expense.id,
    revenueId: revenue.id,
    loanId: loan.id,
  };
}

describe('ProjectionService', () => {
  describe('get12MonthProjection', () => {
    // raw insert helper: explicit type + domainType. Credit-card rows are now
    // bucketed by billing month, so pass `billing` for those (date is incidental).
    const ins = (
      db: DbExecutor,
      userId: string,
      src: string,
      dst: string,
      type: 'deposit' | 'withdrawal' | 'transfer',
      domainType: DomainType,
      amount: string,
      day: number,
      billing?: { month: number; year: number },
    ) =>
      db.insert(transactions).values({
        userId,
        sourceAccountId: src,
        destinationAccountId: dst,
        amount,
        currency: 'BRL',
        type,
        description: domainType,
        date: new Date(2026, 5, day),
        domainType,
        isPaid: false,
        ...(billing && { billingMonth: billing.month, billingYear: billing.year }),
      });

    it('splits income vs personal collections and expense buckets by domain', async () => {
      await withRollback(async (db) => {
        const { projectionService, userId, checkingId, revenueId, expenseId, loanId } =
          await seed(db);
        await ins(db, userId, revenueId, checkingId, 'deposit', 'income_clt', '5000.00', 5);
        // Family loan income is derived from the canonical getMonthlyTotal over real
        // configs, so build it through the flow: a one-time charge of 1000 in June.
        const flow = new FamilyLoanFlowService(db);
        const { config: familyConfig } = await flow.createFamilyLoan(userId, {
          personName: 'João',
        });
        await flow.addOneTimeCharge(userId, {
          configId: familyConfig.id,
          description: 'Parcela João',
          amount: '1000.00',
          date: new Date(2026, 5, 6),
          billingMonth: 6,
          billingYear: 2026,
        });
        await ins(
          db,
          userId,
          expenseId,
          checkingId,
          'withdrawal',
          'credit_card_installment',
          '700.00',
          7,
          { month: 6, year: 2026 },
        );
        await ins(db, userId, checkingId, loanId, 'transfer', 'loan_payment', '800.00', 8);
        await ins(db, userId, checkingId, expenseId, 'transfer', 'recurring_bill', '200.00', 9);

        const p = (await projectionService.get12MonthProjection(userId, new Date(2026, 5, 1)))[0];
        expect(p.income).toBe(5000);
        expect(p.familyLoanIncome).toBe(1000);
        expect(p.totalIncome).toBe(6000);
        expect(p.creditCardExpenses).toBe(700);
        expect(p.loanExpenses).toBe(800);
        expect(p.recurringExpenses).toBe(200);
        expect(p.totalExpenses).toBe(1700);
        expect(p.balance).toBe(4300);
      });
    });

    it('excludes bill_payment transfers from expenses (no double count)', async () => {
      await withRollback(async (db) => {
        const { projectionService, userId, checkingId, expenseId } = await seed(db);
        await ins(
          db,
          userId,
          expenseId,
          checkingId,
          'withdrawal',
          'credit_card_expense',
          '500.00',
          3,
          { month: 6, year: 2026 },
        );
        await ins(db, userId, checkingId, checkingId, 'transfer', 'bill_payment', '500.00', 10);
        const p = (await projectionService.get12MonthProjection(userId, new Date(2026, 5, 1)))[0];
        expect(p.creditCardExpenses).toBe(500);
        expect(p.totalExpenses).toBe(500); // bill_payment NOT added
      });
    });

    it('nets credit-card refunds against card expenses', async () => {
      await withRollback(async (db) => {
        const { projectionService, userId, checkingId, expenseId } = await seed(db);
        await ins(
          db,
          userId,
          expenseId,
          checkingId,
          'withdrawal',
          'credit_card_expense',
          '300.00',
          3,
          { month: 6, year: 2026 },
        );
        await ins(db, userId, checkingId, checkingId, 'deposit', 'credit_card_refund', '50.00', 4, {
          month: 6,
          year: 2026,
        });
        const p = (await projectionService.get12MonthProjection(userId, new Date(2026, 5, 1)))[0];
        expect(p.creditCardExpenses).toBe(250);
      });
    });

    it('converts non-BRL income using the income source exchange rate', async () => {
      await withRollback(async (db) => {
        const { projectionService, userId, checkingId, revenueId } = await seed(db);

        // The revenue account is a USD income source with an exchange rate.
        await db.insert(incomeSourceConfigs).values({
          accountId: revenueId,
          frequency: 'monthly',
          category: 'salary_pj',
          exchangeRate: '5.40',
        });

        // USD income transaction: 1000 USD must project as 5400 BRL.
        await db.insert(transactions).values({
          userId,
          sourceAccountId: revenueId,
          destinationAccountId: checkingId,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'income_pj',
          date: new Date(2026, 5, 5),
          domainType: 'income_pj',
          isPaid: false,
        });

        const p = (await projectionService.get12MonthProjection(userId, new Date(2026, 5, 1)))[0];
        expect(p.income).toBe(5400);
        expect(p.totalIncome).toBe(5400);
        expect(p.balance).toBe(5400);
      });
    });

    it('credit card column uses billing month; recurring = charges + other', async () => {
      await withRollback(async (db) => {
        const { projectionService, userId, checkingId, expenseId } = await seed(db);
        const asOf = new Date(2026, 5, 1); // June is month index 0 of the 12-window

        await db.insert(transactions).values([
          {
            userId,
            sourceAccountId: checkingId,
            destinationAccountId: expenseId,
            amount: '400.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Parcela',
            date: new Date(2026, 4, 28), // dated in May, billed in June
            billingMonth: 6,
            billingYear: 2026,
            domainType: 'credit_card_installment',
          },
          {
            userId,
            sourceAccountId: checkingId,
            destinationAccountId: expenseId,
            amount: '200.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Contador',
            date: new Date(2026, 5, 5),
            domainType: 'recurring_bill',
          },
        ]);

        const proj = await projectionService.get12MonthProjection(userId, asOf);
        const june = proj[0];
        expect(june.creditCardExpenses).toBe(400);
        expect(june.recurringExpenses).toBe(200);
        expect(june.totalExpenses).toBe(600);
      });
    });

    // The projection precomputes family-loan income once via owedByMonthRange and
    // passes it as an override to getSummary, instead of letting getSummary
    // recompute it per config. The override path MUST match the value getSummary
    // computes on its own (no-override). This locks the L4 optimization to be
    // numerically identical across multiple configs and several months.
    it('familyLoanIncome from the precomputed override equals per-month getSummary', async () => {
      await withRollback(async (db) => {
        const { projectionService, userId } = await seed(db);
        const asOf = new Date(2026, 5, 1); // June = month 0 of the window

        const flow = new FamilyLoanFlowService(db);
        // Two configs so the precomputed map sums across configs per month.
        const { config: c1 } = await flow.createFamilyLoan(userId, { personName: 'João' });
        const { config: c2 } = await flow.createFamilyLoan(userId, { personName: 'Maria' });

        // Recurring fixed charge present every month in the window (both configs).
        await flow.addFixedCharge(userId, {
          configId: c1.id,
          description: 'Mensalidade João',
          amount: '500.00',
          startDate: new Date(2026, 5, 5),
          dueDay: 5,
        });
        await flow.addFixedCharge(userId, {
          configId: c2.id,
          description: 'Mensalidade Maria',
          amount: '300.00',
          startDate: new Date(2026, 5, 5),
          dueDay: 5,
        });
        // One-time charges hitting specific months (June for c1, August for c2).
        await flow.addOneTimeCharge(userId, {
          configId: c1.id,
          description: 'Extra junho',
          amount: '120.00',
          date: new Date(2026, 5, 10),
          billingMonth: 6,
          billingYear: 2026,
        });
        await flow.addOneTimeCharge(userId, {
          configId: c2.id,
          description: 'Extra agosto',
          amount: '90.00',
          date: new Date(2026, 7, 10),
          billingMonth: 8,
          billingYear: 2026,
        });

        const proj = await projectionService.get12MonthProjection(userId, asOf);
        const summaryService = new MonthSummaryService(db);

        // Each projected month's familyLoanIncome must equal the no-override
        // getSummary (which recomputes via per-config getMonthlyTotal).
        for (const p of proj) {
          const s = await summaryService.getSummary(userId, p.month, p.year);
          expect(
            p.familyLoanIncome,
            `familyLoanIncome mismatch for ${p.year}-${p.month}`,
          ).toBeCloseTo(s.familyLoanIncome, 2);
        }

        // Sanity: the targeted months carry the expected owed amounts.
        const june = proj.find((p) => p.month === 6 && p.year === 2026);
        const august = proj.find((p) => p.month === 8 && p.year === 2026);
        expect(june?.familyLoanIncome).toBeCloseTo(920, 2); // 500 + 300 + 120
        expect(august?.familyLoanIncome).toBeCloseTo(890, 2); // 500 + 300 + 90
      });
    });

    it('returns 12 months and zeros when empty', async () => {
      await withRollback(async (db) => {
        const { projectionService, userId } = await seed(db);
        const proj = await projectionService.get12MonthProjection(userId, new Date(2026, 5, 1));
        expect(proj).toHaveLength(12);
        expect(proj[0].month).toBe(6);
        expect(proj[0].totalIncome).toBe(0);
        expect(proj[0].totalExpenses).toBe(0);
        expect(proj[0].balance).toBe(0);
      });
    });

    it('materializes the 12-month horizon so a future-month charge is read', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId, expenseId } = await seed(db);
        const scheduledService = new ScheduledService(db);

        // A recurring monthly charge with no materialized rows yet. The schedule
        // alone produces nothing in the projection — only its materialized
        // transactions are read.
        await scheduledService.create(userId, {
          sourceAccountId: checkingId,
          destinationAccountId: expenseId,
          amount: '150.00',
          description: 'Recurring bill',
          frequency: 'monthly',
          startDate: new Date(2026, 5, 5),
          dueDay: 5,
          domainType: 'recurring_bill',
        });

        // Without a guard, future months are NOT materialized → they read 0.
        const noGuard = new ProjectionService(db);
        const unmaterialized = await noGuard.get12MonthProjection(userId, new Date(2026, 5, 1));
        // A future month inside the horizon (e.g. +6 months) has nothing.
        expect(unmaterialized[6].recurringExpenses).toBe(0);
        expect(unmaterialized[6].totalExpenses).toBe(0);

        // With a real guard wired in, the same future month becomes populated
        // because the guard materializes the full horizon before reading.
        const guarded = new ProjectionService(db, new MaterializationGuard(db));
        const materialized = await guarded.get12MonthProjection(userId, new Date(2026, 5, 1));
        expect(materialized[6].recurringExpenses).toBe(150);
        expect(materialized[6].totalExpenses).toBe(150);
        expect(materialized[6].balance).toBe(-150);
      });
    });
  });
});
