import type { DbExecutor } from '@fc/db';
import { accounts, loanConfigs, scheduledTransactions, transactions, userProfiles } from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { LoanFlowService } from './loan-flow.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

// 'YYYY-MM' of a date column (UTC-midnight Date from Drizzle mode:'date').
const ym = (d: Date | string) => new Date(d).toISOString().slice(0, 10).slice(0, 7);

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const flowService = new LoanFlowService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({
      email: 'loan-flow@test.com',
      name: 'Test',
      passwordHash: 'hash',
    })
    .returning();

  const checking = await accountService.create(user.id, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });

  return { accountService, flowService, userId: user.id, checkingId: checking.id };
}

describe('LoanFlowService', () => {
  it.each([
    3,
    undefined,
  ])('does not invent historical payroll settlements when registering installment %s', async (currentInstallment) => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const now = new Date();
      const { schedule } = await flowService.createLoan(userId, {
        name: 'Payroll loan',
        loanCategory: 'bank',
        loanType: 'consignado',
        paymentMethod: 'payroll',
        monthlyPayment: '100.00',
        totalInstallments: 12,
        currentInstallment,
        dueDay: 10,
        startDate: new Date(now.getFullYear(), now.getMonth() - 2, 10),
        checkingAccountId: checkingId,
        monthlyInterestRate: '0.01',
      });
      const rows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      expect(rows.length).toBeGreaterThan(2);
      expect(
        rows.every((row) => !row.isPaid && row.paidAt === null && row.cashAmount === null),
      ).toBe(true);
      expect((await new WalletCashService(db).getWalletCash(userId)).totalCash).toBe(0);
    });
  });
  it('creates loan with account + config + scheduled payments', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const { account, config, schedule, materialized } = await flowService.createLoan(userId, {
        name: 'Itaú Consignado',
        loanCategory: 'bank',
        loanType: 'consignado',
        monthlyPayment: '1500.00',
        totalInstallments: 48,
        currentInstallment: 15,
        dueDay: 10,
        startDate: new Date(2026, 3, 10),
        checkingAccountId: checkingId,
        monthlyInterestRate: '0.01990000',
        payoffCalculationType: 'consignado_mensal',
      });

      expect(account.type).toBe('loan');
      expect(config.loanCategory).toBe('bank');
      expect(schedule.startingOccurrence).toBe(1);
      expect(schedule.totalOccurrences).toBe(48);
      expect(materialized.created).toBeGreaterThan(0);
    });
  });

  it('createLoan is atomic when materialization fails', async () => {
    await withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'loan-atomic@test.com', name: 'Test', passwordHash: 'hash' })
        .returning();
      const accountService = new AccountService(db);
      const checking = await accountService.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const [otherUser] = await db
        .insert(userProfiles)
        .values({ email: 'loan-poison@test.com', name: 'Other', passwordHash: 'hash' })
        .returning();
      const otherAccount = await accountService.create(otherUser.id, {
        name: 'Other Bank',
        type: 'checking',
        currency: 'BRL',
      });

      await db.insert(scheduledTransactions).values({
        userId: user.id,
        sourceAccountId: otherAccount.id,
        destinationAccountId: checking.id,
        amount: '10.00',
        description: 'poison schedule',
        frequency: 'monthly',
        startDate: new Date(2026, 0, 1),
        totalOccurrences: 5,
        startingOccurrence: 1,
        isActive: true,
      });

      const svc = new LoanFlowService(db);
      await expect(
        svc.createLoan(user.id, {
          name: 'Atomic Loan',
          loanCategory: 'bank',
          loanType: 'consignado',
          monthlyPayment: '400.00',
          totalInstallments: 24,
          dueDay: 10,
          startDate: new Date(2026, 0, 10),
          checkingAccountId: checking.id,
          monthlyInterestRate: '0.0185',
        }),
      ).rejects.toThrow(/accountTypeMap/);

      const loanAccounts = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, user.id), eq(accounts.type, 'loan')));
      expect(loanAccounts).toHaveLength(0);

      const loanSchedules = await db
        .select()
        .from(scheduledTransactions)
        .where(
          and(
            eq(scheduledTransactions.userId, user.id),
            eq(scheduledTransactions.domainType, 'loan_payment'),
          ),
        );
      expect(loanSchedules).toHaveLength(0);
    });
  });

  it('creates loan with insurance as separate schedule', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const { insuranceSchedule } = await flowService.createLoan(userId, {
        name: 'Itaú',
        loanCategory: 'bank',
        monthlyPayment: '1500.00',
        totalInstallments: 48,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 3, 10),
        checkingAccountId: checkingId,
        loanType: 'consignado',
        monthlyInterestRate: '0.01990000',
        insuranceAmount: '50.00',
        insurancePaymentDay: 15,
      });

      expect(insuranceSchedule).not.toBeNull();
      expect(insuranceSchedule?.domainType).toBe('loan_insurance');
    });
  });

  it('loan created now with first installment in the FUTURE (Aug) → no payments before Aug, none pre-paid', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      // Created "now" (June 2026), but the first installment is August 2026:
      // the user enters currentInstallment=1 and startDate = the first payment date.
      const { account } = await flowService.createLoan(userId, {
        name: 'Creditas Viagem',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '895.52',
        totalInstallments: 6,
        currentInstallment: 1,
        dueDay: 20,
        startDate: new Date(2026, 7, 20), // 2026-08-20
        checkingAccountId: checkingId,
        monthlyInterestRate: '0.01990000',
      });

      const pays = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.destinationAccountId, account.id), eq(transactions.userId, userId)),
        );
      pays.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      expect(pays).toHaveLength(6);
      // Nothing materializes in June or July — first payment is August.
      expect(pays.every((p) => ym(p.date) >= '2026-08')).toBe(true);
      expect(ym(pays[0].date)).toBe('2026-08');
      expect(pays[0].installmentNumber).toBe(1);
      expect(pays[5].installmentNumber).toBe(6);
      expect(ym(pays[5].date)).toBe('2027-01'); // 6th installment = Jan 2027
      // Nothing is marked paid (loan hasn't started).
      expect(pays.every((p) => p.isPaid === false)).toBe(true);
    });
  });

  it('startDate is the FIRST installment (occurrence 1) — explicit currentInstallment does NOT backdate', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      // startDate is the first installment date; an explicit currentInstallment
      // only controls how many are pre-paid — it must NOT shift occurrence 1.
      const { account } = await flowService.createLoan(userId, {
        name: 'Itaú Consignado',
        loanCategory: 'bank',
        loanType: 'consignado',
        monthlyPayment: '500.00',
        totalInstallments: 12,
        currentInstallment: 3, // explicit override
        dueDay: 15,
        startDate: new Date(2026, 0, 15), // 2026-01-15 = FIRST installment
        checkingAccountId: checkingId,
        monthlyInterestRate: '0.01990000',
      });

      const pays = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.destinationAccountId, account.id), eq(transactions.userId, userId)),
        );
      pays.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Occurrence 1 lands on the first installment date — not backdated.
      expect(ym(pays[0].date)).toBe('2026-01');
      expect(pays[0].installmentNumber).toBe(1);
      // Everything before the 3rd is marked paid.
      const paid = pays
        .filter((p) => p.isPaid)
        .map((p) => p.installmentNumber)
        .sort((a, b) => (a ?? 0) - (b ?? 0));
      expect(paid).toEqual([1, 2]);
    });
  });

  it('derives currentInstallment from a PAST first-installment date when omitted', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const now = new Date();
      // First installment two months ago → this month is the 3rd installment.
      const firstDate = new Date(now.getFullYear(), now.getMonth() - 2, 10);
      const { account } = await flowService.createLoan(userId, {
        name: 'Empréstimo em andamento',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '500.00',
        totalInstallments: 12,
        // currentInstallment omitted → derived from the date
        dueDay: 10,
        startDate: firstDate,
        checkingAccountId: checkingId,
        monthlyInterestRate: '0.01990000',
      });

      const pays = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.destinationAccountId, account.id), eq(transactions.userId, userId)),
        );
      const current = pays.find((p) => ym(p.date) === ym(now));
      expect(current?.installmentNumber).toBe(3); // this month is the 3rd
      expect(current?.isPaid).toBe(false); // current month is not pre-paid
      const paid = pays
        .filter((p) => p.isPaid)
        .map((p) => p.installmentNumber)
        .sort((a, b) => (a ?? 0) - (b ?? 0));
      expect(paid).toEqual([1, 2]); // the two elapsed installments
    });
  });

  it('FUTURE first installment (next month) with currentInstallment omitted → derived 0, nothing pre-paid', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const now = new Date();
      const firstDate = new Date(now.getFullYear(), now.getMonth() + 1, 10); // next month
      const { account } = await flowService.createLoan(userId, {
        name: 'Santander - Sofá',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '773.33',
        totalInstallments: 15,
        // omitted → derived as 0 (first installment is next month)
        dueDay: 10,
        startDate: firstDate,
        checkingAccountId: checkingId,
        monthlyInterestRate: '0.01990000',
      });

      const pays = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.destinationAccountId, account.id), eq(transactions.userId, userId)),
        );
      pays.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      expect(pays).toHaveLength(15);
      // Nothing this month or earlier — first payment is next month.
      expect(pays.every((p) => ym(p.date) > ym(now))).toBe(true);
      expect(pays[0].installmentNumber).toBe(1);
      // Loan hasn't started → nothing is pre-paid.
      expect(pays.every((p) => p.isPaid === false)).toBe(true);
    });
  });

  it('explicit currentInstallment 0 pre-pays nothing (priority over derivation)', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const { account } = await flowService.createLoan(userId, {
        name: 'Santander - Sofá',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '773.33',
        totalInstallments: 15,
        currentInstallment: 0, // explicit: nothing due yet
        dueDay: 10,
        startDate: new Date(2026, 6, 10), // first installment July 2026
        checkingAccountId: checkingId,
        monthlyInterestRate: '0.01990000',
      });

      const pays = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.destinationAccountId, account.id), eq(transactions.userId, userId)),
        );
      expect(pays).toHaveLength(15);
      expect(pays.every((p) => p.isPaid === false)).toBe(true);
    });
  });

  it('calculates payoff info', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const { account } = await flowService.createLoan(userId, {
        name: 'Itaú',
        loanCategory: 'bank',
        loanType: 'consignado',
        monthlyPayment: '1500.00',
        totalInstallments: 48,
        currentInstallment: 17,
        dueDay: 10,
        startDate: new Date(2025, 1, 10),
        checkingAccountId: checkingId,
        monthlyInterestRate: '0.01990000',
        payoffCalculationType: 'consignado_mensal',
      });

      const payoff = await flowService.getPayoffInfo(userId, account.id, new Date(2026, 5, 1));

      expect(payoff.remainingInstallments).toBe(32); // 16 paid; the current installment is still owed.
      const outstanding = Number.parseFloat(payoff.outstandingBalance);
      const savingsNum = Number.parseFloat(payoff.savings);
      expect(outstanding).toBeGreaterThan(0);
      expect(outstanding).toBeLessThan(1500 * 48);
      expect(savingsNum).toBeGreaterThan(0);
    });
  });
});

async function makeUser(db: DbExecutor): Promise<string> {
  const [u] = await db
    .insert(userProfiles)
    .values({
      email: `l-${Math.random().toString(36).slice(2)}@t.dev`,
      name: 'T',
      passwordHash: 'hash',
    })
    .returning();
  return u.id;
}

describe('LoanFlowService.markCurrentAsPaid with wallet', () => {
  it('redirects the source leg to the chosen wallet and returns the target', async () => {
    await withRollback(async (db) => {
      const userId = await makeUser(db);
      const [loan] = await db
        .insert(accounts)
        .values({ userId, name: 'loan', type: 'loan', currency: 'BRL' })
        .returning();
      const [walletA] = await db
        .insert(accounts)
        .values({ userId, name: 'A', type: 'checking', currency: 'BRL' })
        .returning();
      const [walletB] = await db
        .insert(accounts)
        .values({ userId, name: 'B', type: 'checking', currency: 'BRL' })
        .returning();
      await db.insert(transactions).values({
        userId,
        sourceAccountId: walletA.id,
        destinationAccountId: loan.id,
        amount: '900.00',
        currency: 'BRL',
        type: 'transfer',
        description: 'loan payment',
        date: new Date('2026-06-10'),
        domainType: 'loan_payment',
        installmentNumber: 3,
        totalInstallments: 24,
        isPaid: false,
      });

      const service = new LoanFlowService(db);
      const next = await service.getNextPayable(userId, loan.id);
      expect(next?.installmentNumber).toBe(3);
      expect(next?.date).toBe('2026-06-10');

      const res = await service.markCurrentAsPaid(userId, loan.id, walletB.id);
      expect(res.transaction.isPaid).toBe(true);
      expect(res.transaction.sourceAccountId).toBe(walletB.id);

      const undone = await service.markCurrentAsUnpaid(userId, loan.id);
      expect(undone.transaction.isPaid).toBe(false);
    });
  });

  it('markCurrentAsPaid debits the chosen wallet (redirects source leg)', async () => {
    await withRollback(async (db) => {
      const userId = await makeUser(db);
      const [loan] = await db
        .insert(accounts)
        .values({ userId, name: 'Loan', type: 'loan', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Itaú', type: 'checking', currency: 'BRL' })
        .returning();
      const [sys] = await db
        .insert(accounts)
        .values({ userId, name: 'src', type: 'expense', currency: 'BRL' })
        .returning();
      await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: sys.id,
          destinationAccountId: loan.id,
          amount: '900.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'parcela',
          date: new Date('2026-06-10'),
          domainType: 'loan_payment',
          isPaid: false,
        })
        .returning();

      const updated = await new LoanFlowService(db).markCurrentAsPaid(userId, loan.id, wallet.id);
      expect(updated.transaction.isPaid).toBe(true);
      expect(updated.transaction.sourceAccountId).toBe(wallet.id);
      expect(updated.transaction.paidFromAccountId).toBe(wallet.id);
    });
  });

  it('advanceMonth debits the default wallet', async () => {
    await withRollback(async (db) => {
      const userId = await makeUser(db);
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          isDefaultWallet: true,
        })
        .returning();
      const [sys] = await db
        .insert(accounts)
        .values({ userId, name: 'src', type: 'expense', currency: 'BRL' })
        .returning();
      const [loan] = await db
        .insert(accounts)
        .values({ userId, name: 'Loan', type: 'loan', currency: 'BRL' })
        .returning();
      await db.insert(loanConfigs).values({
        accountId: loan.id,
        loanCategory: 'bank',
        loanType: 'pessoal',
        totalInstallments: 12,
        monthlyPayment: '900.00',
        dueDay: 10,
        monthlyInterestRate: '0.01990000',
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: sys.id,
        destinationAccountId: loan.id,
        amount: '900.00',
        currency: 'BRL',
        type: 'transfer',
        description: 'parcela',
        date: new Date('2026-06-10'),
        domainType: 'loan_payment',
        installmentNumber: 1,
        totalInstallments: 12,
        isPaid: false,
      });

      const result = await new LoanFlowService(db).advanceMonth(userId, loan.id);
      expect(result.transaction.isPaid).toBe(true);
      expect(result.transaction.sourceAccountId).toBe(wallet.id);
      expect(result.transaction.paidFromAccountId).toBe(wallet.id);
    });
  });
});
