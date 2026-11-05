import { accounts, loanConfigs, payrollDeductions, transactions } from '@fc/db';
import type { SettlementSnapshot } from '@fc/shared';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';

type Tx = Parameters<Parameters<typeof withRollback>[0]>[0];

async function fixture(db: Tx) {
  const user = await createTestUser(db);
  const [income, wallet, loan] = await db
    .insert(accounts)
    .values([
      { userId: user.id, name: 'Salary', type: 'revenue' as const },
      { userId: user.id, name: 'Wallet', type: 'checking' as const },
      { userId: user.id, name: 'Loan', type: 'loan' as const },
    ])
    .returning();
  const [salary, installment] = await db
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
        destinationAccountId: loan.id,
        amount: '6000.00',
        type: 'withdrawal' as const,
        domainType: 'loan_payment' as const,
        description: 'Installment',
        date: new Date('2026-09-25'),
      },
    ])
    .returning();
  const snapshot: SettlementSnapshot = {
    sourceAccountId: income.id,
    destinationAccountId: wallet.id,
    amount: salary.amount,
    currency: 'BRL',
    exchangeRate: null,
    isPaid: false,
    paidAt: null,
    paidFromAccountId: null,
    cashAmount: null,
    settlementSource: 'legacy',
    settlementDate: null,
  };
  const allocation = {
    userId: user.id,
    incomeTransactionId: salary.id,
    loanTransactionId: installment.id,
    amount: '6000.00',
    grossIncomeBrl: '10000.00',
    incomeBefore: snapshot,
    loanBefore: {
      ...snapshot,
      sourceAccountId: wallet.id,
      destinationAccountId: loan.id,
      amount: installment.amount,
    },
  };
  return { user, income, wallet, loan, salary, installment, allocation };
}

describe('payroll schema invariants', () => {
  it('keeps legacy provenance, permits zero cash and leaves loan classification explicit', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      expect(f.salary).toMatchObject({
        cashAmount: null,
        settlementSource: 'legacy',
        settlementDate: null,
      });
      expect(f.wallet.cashAnchorBasis).toBe('recorded');
      const [zero] = await db
        .update(transactions)
        .set({ cashAmount: '0.00' })
        .where(eq(transactions.id, f.installment.id))
        .returning();
      expect(zero.cashAmount).toBe('0.00');
      const [config] = await db
        .insert(loanConfigs)
        .values({
          accountId: f.loan.id,
          loanCategory: 'bank',
          loanType: 'consignado',
          totalInstallments: 1,
          monthlyPayment: '6000.00',
          dueDay: 25,
          monthlyInterestRate: '0',
        })
        .returning();
      expect(config.paymentMethod).toBeNull();
    });
  });

  it('enforces ownership, active uniqueness and total deductions even for direct writes', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const other = await fixture(db);
      await expect(
        db.transaction((tx) =>
          tx.insert(payrollDeductions).values({
            ...f.allocation,
            loanTransactionId: other.installment.id,
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      const [allocation] = await db.insert(payrollDeductions).values(f.allocation).returning();
      await expect(
        db.transaction((tx) => tx.insert(payrollDeductions).values(f.allocation)),
      ).rejects.toThrow();
      const [secondLoan] = await db
        .insert(transactions)
        .values({
          userId: f.user.id,
          sourceAccountId: f.wallet.id,
          destinationAccountId: f.loan.id,
          amount: '5000.00',
          type: 'withdrawal',
          domainType: 'loan_payment',
          description: 'Second',
          date: new Date('2026-09-25'),
        })
        .returning();
      await expect(
        db.transaction((tx) =>
          tx.insert(payrollDeductions).values({
            ...f.allocation,
            loanTransactionId: secondLoan.id,
            amount: '5000.00',
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      await db
        .update(payrollDeductions)
        .set({ reversedAt: new Date(), reversalReason: 'Test undo' })
        .where(eq(payrollDeductions.id, allocation.id));
      await db.insert(payrollDeductions).values(f.allocation);
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', ${other.user.id}, true)`);
      expect(await db.select().from(payrollDeductions)).toHaveLength(0);
      await expect(
        db.transaction((tx) => tx.insert(payrollDeductions).values(f.allocation)),
      ).rejects.toThrow();
    });
  });

  it('rejects an income source from another owner on a payroll contract', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const other = await fixture(db);
      await expect(
        db.transaction((tx) =>
          tx.insert(loanConfigs).values({
            accountId: f.loan.id,
            loanCategory: 'bank',
            loanType: 'consignado',
            totalInstallments: 1,
            monthlyPayment: '6000.00',
            dueDay: 25,
            monthlyInterestRate: '0',
            paymentMethod: 'payroll',
            incomeSourceAccountId: other.income.id,
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });
  });
});
