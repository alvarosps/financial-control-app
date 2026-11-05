import {
  accounts,
  incomeSourceConfigs,
  loanConfigs,
  monthClosings,
  payrollDeductions,
  transactions,
  userProfiles,
} from '@fc/db';
import { Money } from '@fc/domain';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { noOpGuard } from '../lib/materialization-guard.ts';
import { createTestUser } from '../test/create-test-user.ts';
import { getTestDb } from '../test/pool.ts';
import { withRollback } from '../test/with-rollback.ts';
import { BalanceProjectionService } from './balance-projection.service.ts';
import { DailyControlService } from './daily-control.service.ts';
import { FinancialObligationsService } from './financial-obligations.service.ts';
import { ForecastContextService } from './forecast-context.service.ts';
import { IncomeOccurrenceService } from './income-occurrence.service.ts';
import { LoanFlowService } from './loan-flow.service.ts';
import { MonthOverviewService } from './month-overview.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';
import { PayrollRepairAuditService } from './payroll-repair-audit.service.ts';
import { PayrollSettlementService } from './payroll-settlement.service.ts';
import { ProjectionService } from './projection.service.ts';
import { SettlementService } from './settlement.service.ts';
import { TransactionService } from './transaction.service.ts';

type Tx = Parameters<Parameters<typeof withRollback>[0]>[0];
const recordedAt = new Date('2026-09-26T15:00:00Z');
const effectiveAt = new Date('2026-09-25T15:00:00Z');

async function seed(db: Tx) {
  const user = await createTestUser(db);
  const [income, wallet, payroll, bank] = await db
    .insert(accounts)
    .values([
      { userId: user.id, name: 'Salary', type: 'revenue' as const },
      { userId: user.id, name: 'Wallet', type: 'checking' as const },
      { userId: user.id, name: 'Payroll loan', type: 'loan' as const },
      { userId: user.id, name: 'Bank loan', type: 'loan' as const },
    ])
    .returning();
  await db.insert(incomeSourceConfigs).values({
    accountId: income.id,
    frequency: 'monthly',
    category: 'salary_clt',
    exchangeRate: '5',
    conversionFeePercent: '1',
  });
  await db.insert(loanConfigs).values([
    {
      accountId: payroll.id,
      loanCategory: 'bank' as const,
      loanType: 'consignado' as const,
      monthlyPayment: '1000.00',
      totalInstallments: 12,
      dueDay: 25,
      monthlyInterestRate: '0',
      paymentMethod: 'payroll' as const,
      incomeSourceAccountId: income.id,
    },
    {
      accountId: bank.id,
      loanCategory: 'bank' as const,
      loanType: 'pessoal' as const,
      monthlyPayment: '500.00',
      totalInstallments: 12,
      dueDay: 25,
      monthlyInterestRate: '0',
      paymentMethod: 'bank_debit' as const,
    },
  ]);
  const [salary, first, second, debit, otherSalary] = await db
    .insert(transactions)
    .values([
      {
        userId: user.id,
        sourceAccountId: income.id,
        destinationAccountId: wallet.id,
        amount: '10000.00',
        type: 'deposit' as const,
        domainType: 'income_clt' as const,
        description: 'Salary',
        date: new Date('2026-09-25'),
      },
      {
        userId: user.id,
        sourceAccountId: wallet.id,
        destinationAccountId: payroll.id,
        amount: '600.00',
        type: 'withdrawal' as const,
        domainType: 'loan_payment' as const,
        description: 'First deduction',
        date: new Date('2026-09-25'),
      },
      {
        userId: user.id,
        sourceAccountId: wallet.id,
        destinationAccountId: payroll.id,
        amount: '400.00',
        type: 'withdrawal' as const,
        domainType: 'loan_payment' as const,
        description: 'Second deduction',
        date: new Date('2026-09-25'),
      },
      {
        userId: user.id,
        sourceAccountId: wallet.id,
        destinationAccountId: bank.id,
        amount: '500.00',
        type: 'withdrawal' as const,
        domainType: 'loan_payment' as const,
        description: 'Bank debit',
        date: new Date('2026-09-25'),
      },
      {
        userId: user.id,
        sourceAccountId: income.id,
        destinationAccountId: wallet.id,
        amount: '4000.00',
        type: 'deposit' as const,
        domainType: 'income_clt' as const,
        description: 'Other salary',
        date: new Date('2026-09-15'),
      },
    ])
    .returning();
  const input = {
    incomeTransactionId: salary.id,
    loanTransactionIds: [first.id, second.id],
    walletAccountId: wallet.id,
    settlementDate: effectiveAt,
  };
  return { user, income, wallet, payroll, bank, salary, first, second, debit, otherSalary, input };
}

describe('PayrollSettlementService', () => {
  it('excludes early-settled future income and expenses from cash forecasts but preserves the budget', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      await db
        .update(transactions)
        .set({ date: new Date('2026-10-25') })
        .where(inArray(transactions.id, [f.salary.id, f.first.id, f.second.id, f.debit.id]));
      await new PayrollSettlementService(db, () => recordedAt).settle(f.user.id, f.input);
      await new SettlementService(db).settle(f.user.id, {
        transactionId: f.debit.id,
        walletAccountId: f.wallet.id,
        leg: 'source',
        settlementDate: effectiveAt,
      });
      const projection = new BalanceProjectionService(db);
      expect(await projection.getAnchorCash(f.user.id, recordedAt)).toBe('8500.00');
      const [, october] = await projection.getBaselineCores(f.user.id, {
        horizon: 2,
        asOf: recordedAt,
      });
      expect(october.income.base).toBe(0);
      expect(october.expenses.loan).toBe(0);
      expect(october.net).toBe(0);
      expect(await new MonthSummaryService(db).getSummary(f.user.id, 10, 2026)).toMatchObject({
        income: 10000,
        loanExpenses: 1500,
        balance: 8500,
      });
    });
  });

  it('marks unlinked payroll as unresolved without assigning its source or a precise deposit date', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      await db
        .update(loanConfigs)
        .set({ incomeSourceAccountId: null })
        .where(eq(loanConfigs.accountId, f.payroll.id));
      const sources = await new IncomeOccurrenceService(db).getOccurrences(f.user.id, 9, 2026);
      expect(sources[0]).toMatchObject({
        needsPayrollAllocation: true,
        unlinkedPayrollBrl: '1000.00',
        pendingPayrollBrl: '0.00',
        pendingNetDepositBrl: null,
      });
      expect(sources[0].occurrences.every((occ) => occ.needsPayrollAllocation)).toBe(true);
      const [forecast] = await new ForecastContextService(db).getMonths(
        f.user.id,
        { month: 9, year: 2026 },
        1,
        recordedAt,
      );
      expect(forecast.payrollDateUncertain).toBe(true);
      const dashboard = await new MonthOverviewService(db, noOpGuard).getOverview(
        f.user.id,
        9,
        2026,
        45,
        new Date('2026-09-01T15:00:00Z'),
      );
      expect(dashboard.periods.filter((period) => period.incomeTotal > 0)).toHaveLength(0);
      expect(dashboard.payrollDateUncertain).toBe(true);
      const [config] = await db
        .select()
        .from(loanConfigs)
        .where(eq(loanConfigs.accountId, f.payroll.id));
      expect(config.incomeSourceAccountId).toBeNull();
    });
  });

  it('keeps PJ and rental receipts in the planner while unlinked payroll holds salary and unknown sources', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      await db
        .update(loanConfigs)
        .set({ incomeSourceAccountId: null })
        .where(eq(loanConfigs.accountId, f.payroll.id));
      const [pj, rent, unknown] = await db
        .insert(accounts)
        .values([
          { userId: f.user.id, name: 'PJ', type: 'revenue' as const, currency: 'USD' as const },
          { userId: f.user.id, name: 'Rent', type: 'revenue' as const },
          { userId: f.user.id, name: 'Unknown', type: 'revenue' as const },
        ])
        .returning();
      await db.insert(incomeSourceConfigs).values([
        {
          accountId: pj.id,
          category: 'salary_pj',
          frequency: 'biweekly',
          exchangeRate: '5',
          conversionFeePercent: '1',
        },
        { accountId: rent.id, category: 'rental', frequency: 'monthly' },
      ]);
      await db.insert(transactions).values([
        {
          userId: f.user.id,
          sourceAccountId: pj.id,
          destinationAccountId: f.wallet.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          domainType: 'income_pj',
          description: 'PJ',
          date: new Date('2026-09-09'),
        },
        {
          userId: f.user.id,
          sourceAccountId: rent.id,
          destinationAccountId: f.wallet.id,
          amount: '1400.00',
          type: 'deposit',
          domainType: 'income_rental',
          description: 'Rent',
          date: new Date('2026-09-30'),
        },
        {
          userId: f.user.id,
          sourceAccountId: unknown.id,
          destinationAccountId: f.wallet.id,
          amount: '100.00',
          type: 'deposit',
          domainType: 'income_pj',
          description: 'Unknown',
          date: new Date('2026-09-30'),
        },
      ]);
      const sources = await new IncomeOccurrenceService(db).getOccurrences(f.user.id, 9, 2026);
      for (const id of [f.income.id, unknown.id]) {
        expect(sources.find((s) => s.accountId === id)).toMatchObject({
          needsPayrollAllocation: true,
          pendingNetDepositBrl: null,
        });
      }
      for (const [id, amount] of [
        [pj.id, '4950.00'],
        [rent.id, '1400.00'],
      ]) {
        const source = sources.find((s) => s.accountId === id);
        expect(source).toMatchObject({
          needsPayrollAllocation: false,
          pendingNetDepositBrl: amount,
        });
        expect(source?.occurrences[0]).toMatchObject({
          needsPayrollAllocation: false,
          amountBrl: amount,
          isPaid: false,
        });
      }
      const overview = await new MonthOverviewService(db, noOpGuard).getOverview(
        f.user.id,
        9,
        2026,
        30,
        new Date('2026-09-01T15:00:00Z'),
      );
      expect(overview.payrollDateUncertain).toBe(true);
      expect(
        overview.periods.filter((p) => p.incomeTotal > 0).map((p) => [p.incomeDate, p.incomeTotal]),
      ).toEqual([
        ['2026-09-09', 4950],
        ['2026-09-30', 1400],
      ]);
      const obligations = await new FinancialObligationsService(db, noOpGuard).listForDuePeriod(
        f.user.id,
        9,
        2026,
      );
      expect(obligations.summary.receivableCount).toBe(2);
      expect(obligations.summary.toReceive).toBe('6350.00');
      expect(
        obligations.items
          .filter((item) => item.status === 'open' && item.direction === 'receivable')
          .map((item) => item.name),
      ).toEqual(['PJ', 'Rent']);
    });
  });

  it('promotes date-assumed income to payroll and restores the assumption on undo', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      await new SettlementService(db).settle(f.user.id, {
        transactionId: f.salary.id,
        walletAccountId: f.wallet.id,
        leg: 'destination',
        settlementSource: 'date_assumed',
        settlementDate: effectiveAt,
      });
      const [before] = await db.select().from(transactions).where(eq(transactions.id, f.salary.id));
      const service = new PayrollSettlementService(db, () => recordedAt);
      expect(await service.settle(f.user.id, f.input)).toMatchObject({ cashAmount: '9000.00' });
      await service.undo(f.user.id, f.salary.id);
      const [restored] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, f.salary.id));
      expect(restored).toMatchObject({
        isPaid: true,
        settlementSource: 'date_assumed',
        cashAmount: '10000.00',
        paidAt: before.paidAt,
        settlementDate: before.settlementDate,
      });
      expect(await new BalanceProjectionService(db).getAnchorCash(f.user.id, recordedAt)).toBe(
        '0.00',
      );
    });
  });

  it('audits exact loan IDs read-only without inferring a method from the contract name', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      await db
        .update(loanConfigs)
        .set({ paymentMethod: null, incomeSourceAccountId: null })
        .where(eq(loanConfigs.accountId, f.payroll.id));
      await db.update(accounts).set({ name: 'Creditas' }).where(eq(accounts.id, f.payroll.id));
      const before = await db.select().from(transactions).where(eq(transactions.userId, f.user.id));
      await db.execute(sql`SET LOCAL transaction_read_only = on`);
      const audit = await new PayrollRepairAuditService(db).audit(
        {
          userId: f.user.id,
          loanAccountIds: [f.payroll.id, f.bank.id],
          fromPeriod: '2026-09',
          toPeriod: '2026-09',
        },
        'a'.repeat(64),
      );
      expect(audit.loans.find((loan) => loan.account.id === f.payroll.id)).toMatchObject({
        config: { paymentMethod: null },
        proposedPaymentMethod: null,
        requiresEvidence: true,
      });
      expect(audit.wallets[0]).toHaveProperty('cashAnchorBasis', 'recorded');
      expect(audit.occurrences[0]).toHaveProperty('cashAmount');
      expect(audit.economicTotals).toEqual([
        { currency: 'BRL', income: '14000.00', loans: '1500.00' },
      ]);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toEqual(before);
    });
  });

  it('presents an unallocated payroll as a monthly net estimate without inventing a salary date', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      const daily = await new DailyControlService(db).getDailyControl(f.user.id, 9, 2026);
      expect(
        daily.days
          .flatMap((day) => day.items)
          .filter((item) =>
            [f.salary.id, f.otherSalary.id, f.first.id, f.second.id].includes(item.id),
          ),
      ).toHaveLength(0);
      expect(
        daily.undatedItems.find((item) => item.id === `payroll-estimate-${f.income.id}`),
      ).toMatchObject({ amount: 13000, settlementSource: 'predicted', dateUncertain: true });
      expect(daily.summary).toMatchObject({ totalIn: 13000, totalOut: 500, balance: 12500 });
      expect((await new MonthSummaryService(db).getSummary(f.user.id, 9, 2026)).balance).toBe(
        12500,
      );
    });
  });

  it('keeps the economic budget gross while the calendar shows net cash and zero-cash deductions', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      await new PayrollSettlementService(db, () => recordedAt).settle(f.user.id, f.input);
      const audit = await new PayrollRepairAuditService(db).audit(
        {
          userId: f.user.id,
          loanAccountIds: [f.payroll.id, f.bank.id],
          fromPeriod: '2026-09',
          toPeriod: '2026-09',
        },
        'a'.repeat(64),
      );
      expect(audit.economicTotals).toEqual([
        { currency: 'BRL', income: '14000.00', loans: '1500.00' },
      ]);
      expect(audit.allocations).toHaveLength(2);
      expect(audit.occurrences.find((row) => row.id === f.salary.id)).toMatchObject({
        amount: '10000.00',
        cashAmount: '9000.00',
        settlementSource: 'payroll',
      });
      const budget = await new MonthSummaryService(db).getSummary(f.user.id, 9, 2026);
      expect(budget).toMatchObject({ income: 14000, loanExpenses: 1500, balance: 12500 });
      const daily = await new DailyControlService(db).getDailyControl(f.user.id, 9, 2026);
      const items = daily.days.flatMap((day) => day.items);
      expect(items.find((item) => item.id === f.salary.id)?.amount).toBe(9000);
      expect(items.find((item) => item.id === f.first.id)?.amount).toBe(0);
      expect(items.find((item) => item.id === f.debit.id)?.amount).toBe(500);
      const projection = await new ProjectionService(db).get12MonthProjection(
        f.user.id,
        recordedAt,
      );
      expect(projection[0].balance).toBe(budget.balance);
      const balance = new BalanceProjectionService(db);
      const cash = await balance.getAnchorCash(f.user.id, recordedAt);
      const dashboard = await new MonthOverviewService(db, noOpGuard).getOverview(
        f.user.id,
        9,
        2026,
        45,
        recordedAt,
      );
      expect(dashboard.cashToday).toBe(Number(cash));
      const [core] = await balance.getBaselineCores(f.user.id, { horizon: 1, asOf: recordedAt });
      expect(Money.fromString(cash, 'BRL').add(Money.fromNumber(core.net, 'BRL')).toNumber()).toBe(
        budget.balance,
      );
    });
  });

  it('serializes simultaneous requests on separate database transactions without duplicate deductions', async () => {
    const root = getTestDb();
    const f = await root.transaction(seed);
    try {
      const service = new PayrollSettlementService(root, () => recordedAt);
      const [first, retry] = await Promise.all([
        service.settle(f.user.id, f.input),
        service.settle(f.user.id, f.input),
      ]);
      expect(retry).toEqual(first);
      expect(
        await root.select().from(payrollDeductions).where(eq(payrollDeductions.userId, f.user.id)),
      ).toHaveLength(2);
    } finally {
      await root.transaction(async (db) => {
        await db.delete(payrollDeductions).where(eq(payrollDeductions.userId, f.user.id));
        await db.delete(transactions).where(eq(transactions.userId, f.user.id));
        for (const id of [f.payroll.id, f.bank.id])
          await db.delete(loanConfigs).where(eq(loanConfigs.accountId, id));
        await db.delete(accounts).where(eq(accounts.userId, f.user.id));
        await db.delete(userProfiles).where(eq(userProfiles.id, f.user.id));
      });
    }
  });

  it('offers only owned compatible deductions and requires undo before rebinding a loan', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      const other = await seed(db);
      const service = new PayrollSettlementService(db, () => recordedAt);
      const options = await service.options(f.user.id, f.salary.id);
      expect(options.candidates.map((row) => row.transactionId).sort()).toEqual(
        [f.first.id, f.second.id].sort(),
      );
      await expect(service.options(other.user.id, f.salary.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      const loan = new LoanFlowService(db);
      await expect(
        loan.setPaymentMethod(f.user.id, f.bank.id, 'payroll', other.income.id),
      ).rejects.toThrow();
      await service.settle(f.user.id, f.input);
      await expect(
        loan.setPaymentMethod(f.user.id, f.payroll.id, 'bank_debit', null),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await service.undo(f.user.id, f.salary.id);
      expect(
        await loan.setPaymentMethod(f.user.id, f.payroll.id, 'bank_debit', null),
      ).toMatchObject({ paymentMethod: 'bank_debit', incomeSourceAccountId: null });
    });
  });

  it('settles net income and zero-cash deductions, keeps bank debit separate and retries without duplicates', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      const service = new PayrollSettlementService(db, () => recordedAt);
      const result = await service.settle(f.user.id, f.input);
      expect(result).toMatchObject({
        grossBrl: '10000.00',
        deductionsBrl: '1000.00',
        cashAmount: '9000.00',
      });
      expect(await service.settle(f.user.id, f.input)).toEqual(result);
      const [salary] = await db.select().from(transactions).where(eq(transactions.id, f.salary.id));
      expect(salary).toMatchObject({
        amount: '10000.00',
        cashAmount: '9000.00',
        settlementSource: 'payroll',
        settlementDate: effectiveAt,
        paidAt: recordedAt,
      });
      const deductions = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, f.user.id),
            eq(transactions.destinationAccountId, f.payroll.id),
          ),
        );
      expect(deductions.map((row) => [row.amount, row.cashAmount, row.isPaid])).toEqual([
        ['600.00', '0.00', true],
        ['400.00', '0.00', true],
      ]);
      const bank = await new SettlementService(db).settle(f.user.id, {
        transactionId: f.debit.id,
        walletAccountId: f.wallet.id,
        leg: 'source',
        settlementDate: effectiveAt,
      });
      expect(bank).toMatchObject({
        amount: '500.00',
        cashAmount: '500.00',
        settlementSource: 'manual',
      });
      expect(
        Money.fromString(salary.cashAmount ?? '', 'BRL')
          .subtract(Money.fromString(bank.cashAmount ?? '', 'BRL'))
          .toDbString(),
      ).toBe('8500.00');
      expect(
        await db.select().from(payrollDeductions).where(eq(payrollDeductions.userId, f.user.id)),
      ).toHaveLength(2);
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, f.otherSalary.id)))[0]
          .isPaid,
      ).toBe(false);
    });
  });

  it('undoes all allocations atomically and can reapply without changing economic amounts', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      const service = new PayrollSettlementService(db, () => recordedAt);
      await service.settle(f.user.id, f.input);
      await service.undo(f.user.id, f.salary.id);
      for (const original of [f.salary, f.first, f.second]) {
        const [row] = await db.select().from(transactions).where(eq(transactions.id, original.id));
        expect(row).toMatchObject({
          amount: original.amount,
          currency: original.currency,
          isPaid: false,
          cashAmount: null,
          settlementDate: null,
          settlementSource: 'legacy',
        });
      }
      await service.settle(f.user.id, f.input);
      expect(
        await db
          .select()
          .from(payrollDeductions)
          .where(
            and(eq(payrollDeductions.userId, f.user.id), isNull(payrollDeductions.reversedAt)),
          ),
      ).toHaveLength(2);
    });
  });

  it('requires review of a reported net difference and never converts already-BRL income again', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      const service = new PayrollSettlementService(db, () => recordedAt);
      await expect(
        service.settle(f.user.id, { ...f.input, reportedNetBrl: '8900.00' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      const result = await service.settle(f.user.id, {
        ...f.input,
        reportedNetBrl: '8900.00',
        acknowledgeDifference: true,
      });
      expect(result).toMatchObject({
        grossBrl: '10000.00',
        expectedNetBrl: '9000.00',
        differenceBrl: '-100.00',
        cashAmount: '8900.00',
      });
    });
  });

  it('converts foreign income once with its fee and preserves its original currency', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      await db
        .update(transactions)
        .set({ amount: '2000.00', currency: 'USD', exchangeRate: '5' })
        .where(eq(transactions.id, f.salary.id));
      const result = await new PayrollSettlementService(db, () => recordedAt).settle(
        f.user.id,
        f.input,
      );
      expect(result).toMatchObject({
        grossBrl: '9900.00',
        deductionsBrl: '1000.00',
        cashAmount: '8900.00',
      });
      const [income] = await db.select().from(transactions).where(eq(transactions.id, f.salary.id));
      expect(income).toMatchObject({
        amount: '2000.00',
        currency: 'USD',
        exchangeRate: '5.000000',
        cashAmount: '8900.00',
      });
    });
  });

  it('rejects cross-user IDs, bank-debit installments and reusing a deduction on another salary', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      const other = await seed(db);
      const service = new PayrollSettlementService(db, () => recordedAt);
      await expect(service.settle(other.user.id, f.input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        service.settle(f.user.id, { ...f.input, loanTransactionIds: [other.first.id] }),
      ).rejects.toThrow();
      await expect(
        service.settle(f.user.id, { ...f.input, loanTransactionIds: [f.debit.id] }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await service.settle(f.user.id, f.input);
      await expect(
        service.settle(f.user.id, { ...f.input, incomeTransactionId: f.otherSalary.id }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  it('blocks generic settlement, undo, amount edits and reversal of allocated occurrences', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      const service = new PayrollSettlementService(db, () => recordedAt);
      const settlement = new SettlementService(db);
      await expect(
        settlement.settle(f.user.id, {
          transactionId: f.first.id,
          walletAccountId: f.wallet.id,
          leg: 'source',
        }),
      ).rejects.toThrow();
      await service.settle(f.user.id, f.input);
      for (const id of [f.salary.id, f.first.id]) {
        await expect(settlement.unsettle(f.user.id, id)).rejects.toThrow();
        await expect(new TransactionService(db).markAsUnpaid(f.user.id, id)).rejects.toThrow();
        await expect(
          new TransactionService(db).update(f.user.id, id, { amount: '1.00' }),
        ).rejects.toThrow();
        await expect(new TransactionService(db).reverse(f.user.id, id)).rejects.toThrow();
      }
    });
  });

  it('protects allocated values and loan bindings even through direct database writes', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      await new PayrollSettlementService(db, () => recordedAt).settle(f.user.id, f.input);
      await expect(
        db.transaction(async (tx) => {
          await tx
            .update(transactions)
            .set({ cashAmount: '1.00' })
            .where(eq(transactions.id, f.first.id));
        }),
      ).rejects.toThrow();
      await expect(
        db.transaction(async (tx) => {
          await tx
            .update(loanConfigs)
            .set({ paymentMethod: 'bank_debit', incomeSourceAccountId: null })
            .where(eq(loanConfigs.accountId, f.first.destinationAccountId));
        }),
      ).rejects.toThrow();
    });
  });

  it('does not settle or undo across a closed occurrence or effective month', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      const service = new PayrollSettlementService(db, () => recordedAt);
      await db
        .insert(monthClosings)
        .values({ userId: f.user.id, month: 8, year: 2026, status: 'closed' });
      await expect(
        service.settle(f.user.id, { ...f.input, settlementDate: new Date('2026-08-31T15:00:00Z') }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await service.settle(f.user.id, f.input);
      await db
        .insert(monthClosings)
        .values({ userId: f.user.id, month: 9, year: 2026, status: 'closed' });
      await expect(service.undo(f.user.id, f.salary.id)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(
        await db
          .select()
          .from(payrollDeductions)
          .where(
            and(eq(payrollDeductions.userId, f.user.id), isNull(payrollDeductions.reversedAt)),
          ),
      ).toHaveLength(2);
    });
  });
});
