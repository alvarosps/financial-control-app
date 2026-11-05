import type { DbExecutor } from '@fc/db';
import { accounts, creditCardBills, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { expectDbError } from '../test/assert-db-error.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { FamilyLoanLedgerService } from './family-loan-ledger.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const ccFlowService = new CreditCardFlowService(db);
  const flowService = new FamilyLoanFlowService(db);
  const ledgerService = new FamilyLoanLedgerService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({
      email: 'family-loan-ledger@test.com',
      name: 'Test',
      passwordHash: 'hash',
    })
    .returning();

  await accountService.create(user.id, { name: 'Bank', type: 'checking', currency: 'BRL' });

  return { accountService, ccFlowService, flowService, ledgerService, userId: user.id };
}

describe('FamilyLoanLedgerService', () => {
  it.each([
    { dueDate: null, month: 9 },
    { dueDate: '2026-10-10', month: 10 },
  ])('keeps borrowed-card receipts in the due month $month across all readers', async ({
    dueDate,
    month,
  }) => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, accountService, ccFlowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Relative' });
      const { account: card } = await ccFlowService.createCreditCard(userId, {
        name: 'Borrowed card',
        closingDay: 28,
        dueDay: 10,
      });
      await flowService.addBorrowedCard(userId, {
        configId: config.id,
        creditCardAccountId: card.id,
      });
      const expense = await accountService.create(userId, {
        name: 'Expense',
        type: 'expense',
        currency: 'BRL',
      });
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Purchase',
          date: new Date('2026-08-20'),
          billingMonth: 8,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        },
        {
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          amount: '100.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Refund',
          date: new Date('2026-08-21'),
          billingMonth: 8,
          billingYear: 2026,
          domainType: 'credit_card_refund',
        },
        {
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          amount: '900.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'Payment',
          date: new Date('2026-09-10'),
          billingMonth: 8,
          billingYear: 2026,
          domainType: 'bill_payment',
        },
      ]);
      if (dueDate)
        await db.insert(creditCardBills).values({
          creditCardAccountId: card.id,
          month: 8,
          year: 2026,
          dueDate,
          dueDateSource: 'institution',
        });
      expect(await ledgerService.firstOwedMonth(userId, config.id)).toEqual({ month, year: 2026 });
      expect(
        (await ledgerService.getMonthlyTotal(userId, config.id, 8, 2026)).borrowedCardTotal,
      ).toBe(0);
      expect(
        (await ledgerService.getMonthlyTotal(userId, config.id, month, 2026)).borrowedCardTotal,
      ).toBe(900);
      const range = await ledgerService.owedByMonthRange(
        userId,
        config.id,
        { month: 8, year: 2026 },
        { month: 10, year: 2026 },
      );
      expect(range.filter((row) => row.owed !== 0)).toEqual([
        { monthKey: `2026-${String(month).padStart(2, '0')}`, owed: 900, borrowedCardTotal: 900 },
      ]);
    });
  });

  it('gets monthly total with correct breakdown', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      await flowService.addFixedCharge(userId, {
        configId: config.id,
        description: 'Mensalidade',
        amount: '500.00',
        startDate: new Date(2026, 3, 5),
        dueDay: 5,
      });
      await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Extra abril',
        amount: '200.00',
        date: new Date(2026, 3, 15),
      });
      await flowService.addDiscount(userId, {
        configId: config.id,
        description: 'Desconto',
        amount: '100.00',
        date: new Date(2026, 3, 20),
      });

      const total = await ledgerService.getMonthlyTotal(userId, config.id, 4, 2026);
      expect(total.fixedCharges).toBe(500);
      expect(total.oneTimeCharges).toBe(200);
      expect('oneTimePayments' in total).toBe(false);
      expect(total.items.expenses[0]?.isPaid).toBe(false);
      expect(total.discounts).toBe(100);
      expect(total.installments).toBe(0);
      expect(total.borrowedCardTotal).toBe(0);
      expect(total.subtotal).toBe(700);
      expect(total.total).toBe(600);
    });
  });

  it('subtracts a discount stored in the revenue→family-loan direction', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, accountService, userId } = await seed(db);
      const { account, config } = await flowService.createFamilyLoan(userId, {
        personName: 'Célia',
      });
      await flowService.addInstallment(userId, {
        configId: config.id,
        description: 'TV Samsung',
        amount: '300.00',
        totalInstallments: 10,
        currentInstallment: 1,
        dueDay: 10,
        billingMonth: 4,
        billingYear: 2026,
      });
      const revenue = await accountService.create(userId, {
        name: 'Revenue',
        type: 'revenue',
        currency: 'BRL',
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: revenue.id,
        destinationAccountId: account.id,
        amount: '100.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Desconto serviço prestado',
        date: new Date(2026, 3, 15),
        domainType: 'family_loan_discount',
        isPaid: false,
      });

      const total = await ledgerService.getMonthlyTotal(userId, config.id, 4, 2026);
      expect(total.installments).toBe(300);
      expect(total.discounts).toBe(100);
      expect(total.subtotal).toBe(300);
      expect(total.total).toBe(200);
    });
  });

  it('itemizes installments with the current parcela for the month', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      await flowService.addInstallment(userId, {
        configId: config.id,
        description: 'TV Samsung',
        amount: '300.00',
        totalInstallments: 10,
        currentInstallment: 3,
        dueDay: 10,
        billingMonth: 4,
        billingYear: 2026,
      });

      const april = await ledgerService.getMonthlyTotal(userId, config.id, 4, 2026);
      const june = await ledgerService.getMonthlyTotal(userId, config.id, 6, 2026);
      expect(april.items.installments).toHaveLength(1);
      const aprilParcela = april.items.installments[0].installmentNumber;
      expect(aprilParcela).not.toBeNull();
      expect(april.items.installments[0].totalInstallments).toBe(10);
      expect(june.items.installments).toHaveLength(1);
      expect(june.items.installments[0]).toMatchObject({
        description: 'TV Samsung',
        totalInstallments: 10,
        domainType: 'family_loan_installment',
      });
      expect(june.items.installments[0].installmentNumber).toBe((aprilParcela ?? 0) + 2);
      expect(june.items.installments[0].installmentNumber).not.toBe(1);
      expect(june.items.installments[0].scheduledTransactionId).not.toBeNull();
      const before = await ledgerService.getMonthlyTotal(userId, config.id, 12, 2025);
      expect(before.items.installments).toHaveLength(0);
    });
  });

  it('get12MonthProjection returns 12 entries computed from owedByMonthRange', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      const now = new Date();
      await flowService.addFixedCharge(userId, {
        configId: config.id,
        description: 'Mensalidade fixa',
        amount: '500.00',
        startDate: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 10)),
        dueDay: 10,
      });

      const projection = await ledgerService.get12MonthProjection(userId, config.id, {
        month: now.getUTCMonth() + 1,
        year: now.getUTCFullYear(),
      });

      expect(projection).toHaveLength(12);
      expect(projection[0].month).toBe(now.getUTCMonth() + 1);
      expect(projection[0].year).toBe(now.getUTCFullYear());
      // Equivalência com a fonte canônica de um mês (mesma garantia do teste
      // de equivalência do owedByMonthRange, aplicada à projeção):
      const single = await ledgerService.getMonthlyTotal(
        userId,
        config.id,
        projection[0].month,
        projection[0].year,
      );
      expect(projection[0].total).toBeCloseTo(single.total, 2);
      expect(projection[0].borrowedCardTotal).toBeCloseTo(single.borrowedCardTotal, 2);
      // Shape novo: sem os campos itemizados do getMonthlyTotal.
      expect('items' in projection[0]).toBe(false);
    });
  });

  it('owedByMonthRange returns one entry per month with net owed', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'C1',
        amount: '300.00',
        date: new Date(2026, 4, 15),
        billingMonth: 5,
        billingYear: 2026,
      });
      await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'C2',
        amount: '200.00',
        date: new Date(2026, 5, 15),
        billingMonth: 6,
        billingYear: 2026,
      });
      const rows = await ledgerService.owedByMonthRange(
        userId,
        config.id,
        { month: 5, year: 2026 },
        { month: 6, year: 2026 },
      );
      expect(rows.find((r) => r.monthKey === '2026-05')?.owed).toBe(300);
      expect(rows.find((r) => r.monthKey === '2026-06')?.owed).toBe(200);
    });
  });

  it('firstOwedMonth returns the earliest owed month', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'C',
        amount: '100.00',
        date: new Date(2026, 2, 10),
        billingMonth: 3,
        billingYear: 2026,
      });
      const first = await ledgerService.firstOwedMonth(userId, config.id);
      expect(first).toEqual({ month: 3, year: 2026 });
    });
  });

  it('includes a NULL-billingMonth borrowed-card charge by transaction date', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, accountService, ccFlowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      const { account: cardAccount } = await ccFlowService.createCreditCard(userId, {
        name: 'Nubank Célia',
        closingDay: 3,
        dueDay: 10,
      });
      await flowService.addBorrowedCard(userId, {
        configId: config.id,
        creditCardAccountId: cardAccount.id,
      });
      const expense = await accountService.create(userId, {
        name: 'Expense',
        type: 'expense',
        currency: 'BRL',
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expense.id,
        destinationAccountId: cardAccount.id,
        amount: '150.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Compra sem billingMonth',
        date: new Date(2026, 5, 15),
        billingMonth: null,
        billingYear: null,
        domainType: 'credit_card_expense',
        isPaid: false,
      });
      const total = await ledgerService.getMonthlyTotal(userId, config.id, 6, 2026);
      expect(total.borrowedCardTotal).toBe(150);
      expect(total.subtotal).toBe(150);
      expect(total.total).toBe(150);
    });
  });

  it('getLedger reproduces May→June arrears oldest-first', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, accountService, userId } = await seed(db);
      const wallet = await accountService.create(userId, {
        name: 'Itaú',
        type: 'checking',
        currency: 'BRL',
      });
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      for (const [month, description] of [
        [5, 'Maio'],
        [6, 'Junho'],
      ] as const) {
        await flowService.addOneTimeCharge(userId, {
          configId: config.id,
          description,
          amount: '5000.00',
          date: new Date(2026, month - 1, 15),
          billingMonth: month,
          billingYear: 2026,
        });
      }
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
        .where(eq(accounts.id, wallet.id));
      await flowService.recordPayment(userId, {
        configId: config.id,
        amount: '4000.00',
        date: new Date(2026, 4, 31),
        walletAccountId: wallet.id,
      });
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
        .where(eq(accounts.id, wallet.id));
      await flowService.recordPayment(userId, {
        configId: config.id,
        amount: '2000.00',
        date: new Date(2026, 5, 15),
        walletAccountId: wallet.id,
      });
      const ledger = await ledgerService.getLedger(userId, config.id, {
        asOf: new Date(2026, 5, 20),
      });
      expect(ledger.months.find((x) => x.monthKey === '2026-05')).toMatchObject({
        remaining: 0,
        status: 'paid',
      });
      expect(ledger.months.find((x) => x.monthKey === '2026-06')).toMatchObject({
        paid: 1000,
        remaining: 4000,
        status: 'partially_paid',
      });
    });
  });

  it('uses an explicit current period instead of the process clock for overdue status', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Cobrança julho',
        amount: '500.00',
        date: new Date(Date.UTC(2026, 6, 10)),
      });

      const ledger = await ledgerService.getLedger(userId, config.id, {
        asOf: new Date(Date.UTC(2026, 7, 1, 1)),
        currentPeriod: { month: 7, year: 2026 },
      });

      expect(ledger.months.find((entry) => entry.monthKey === '2026-07')).toMatchObject({
        remaining: 500,
        status: 'open',
      });
      expect(ledger.totals.totalOverdue).toBe(0);
    });
  });

  it('firstOwedMonth: borrowed-card rows across a year boundary do not yield a phantom month', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, accountService, ccFlowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      const { account: cardAccount } = await ccFlowService.createCreditCard(userId, {
        name: 'Nubank Célia',
        closingDay: 3,
        dueDay: 10,
      });
      await flowService.addBorrowedCard(userId, {
        configId: config.id,
        creditCardAccountId: cardAccount.id,
      });
      const expense = await accountService.create(userId, {
        name: 'Expense',
        type: 'expense',
        currency: 'BRL',
      });
      for (const [month, year, amount, description] of [
        [12, 2026, '300.00', 'Compra dezembro'],
        [1, 2027, '200.00', 'Compra janeiro'],
      ] as const) {
        await db.insert(transactions).values({
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: cardAccount.id,
          amount,
          currency: 'BRL',
          type: 'withdrawal',
          description,
          date: new Date(Date.UTC(year, month - 1, 10)),
          billingMonth: month,
          billingYear: year,
          domainType: 'credit_card_expense',
          isPaid: false,
        });
      }
      const first = await ledgerService.firstOwedMonth(userId, config.id);
      expect(first).toEqual({ month: 12, year: 2026 });
    });
  });

  it('firstOwedMonth: a backdated PAYMENT does not pull the ledger start before the first charge', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, accountService, userId } = await seed(db);
      const wallet = await accountService.create(userId, {
        name: 'Itaú',
        type: 'checking',
        currency: 'BRL',
      });
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Cobrança junho',
        amount: '500.00',
        date: new Date(2026, 5, 10),
        billingMonth: 6,
        billingYear: 2026,
      });
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
        .where(eq(accounts.id, wallet.id));
      await flowService.recordPayment(userId, {
        configId: config.id,
        amount: '100.00',
        date: new Date(2026, 0, 5),
        walletAccountId: wallet.id,
      });
      expect(await ledgerService.firstOwedMonth(userId, config.id)).toEqual({
        month: 6,
        year: 2026,
      });
    });
  });

  it('rejects an out-of-range billing_month through database validation', async () => {
    await withRollback(async (db) => {
      const { accountService, ccFlowService, userId } = await seed(db);
      const { account: cardAccount } = await ccFlowService.createCreditCard(userId, {
        name: 'Nubank Célia',
        closingDay: 3,
        dueDay: 10,
      });
      const expense = await accountService.create(userId, {
        name: 'Expense',
        type: 'expense',
        currency: 'BRL',
      });
      await expectDbError(
        db.insert(transactions).values({
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: cardAccount.id,
          amount: '175.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Compra billing inválido',
          date: new Date(Date.UTC(2026, 5, 15)),
          billingMonth: 13,
          billingYear: 2026,
          domainType: 'credit_card_expense',
          isPaid: false,
        }),
        /chk_transactions_billing_month|check constraint|date field value out of range/i,
      );
    });
  });

  it('owedByMonthRange equals getMonthlyTotal.total per month for every component type', async () => {
    await withRollback(async (db) => {
      const { flowService, ledgerService, accountService, ccFlowService, userId } = await seed(db);
      const { account, config } = await flowService.createFamilyLoan(userId, {
        personName: 'Célia',
      });
      const months = [
        { month: 4, year: 2026 },
        { month: 5, year: 2026 },
        { month: 6, year: 2026 },
      ];
      await flowService.addInstallment(userId, {
        configId: config.id,
        description: 'TV Samsung',
        amount: '300.00',
        totalInstallments: 10,
        currentInstallment: 3,
        dueDay: 12,
        billingMonth: 4,
        billingYear: 2026,
      });
      await flowService.addFixedCharge(userId, {
        configId: config.id,
        description: 'Mensalidade fixa',
        amount: '500.00',
        startDate: new Date(Date.UTC(2026, 3, 14)),
        dueDay: 14,
      });
      await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Extra maio',
        amount: '200.00',
        date: new Date(Date.UTC(2026, 4, 18)),
        billingMonth: 5,
        billingYear: 2026,
      });
      await flowService.addDiscount(userId, {
        configId: config.id,
        description: 'Desconto serviço',
        amount: '100.00',
        date: new Date(Date.UTC(2026, 5, 16)),
      });
      const revenue = await accountService.create(userId, {
        name: 'Revenue',
        type: 'revenue',
        currency: 'BRL',
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: revenue.id,
        destinationAccountId: account.id,
        amount: '80.00',
        currency: 'BRL',
        type: 'transfer',
        description: 'Desconto V1 transfer',
        date: new Date(Date.UTC(2026, 3, 17)),
        domainType: 'family_loan_discount',
        isPaid: false,
      });
      const { account: cardAccount } = await ccFlowService.createCreditCard(userId, {
        name: 'Nubank Célia',
        closingDay: 3,
        dueDay: 10,
      });
      await flowService.addBorrowedCard(userId, {
        configId: config.id,
        creditCardAccountId: cardAccount.id,
      });
      const expense = await accountService.create(userId, {
        name: 'Expense',
        type: 'expense',
        currency: 'BRL',
      });
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: cardAccount.id,
          amount: '250.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Compra cartão junho',
          date: new Date(Date.UTC(2026, 5, 13)),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
        {
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: cardAccount.id,
          amount: '150.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Compra sem billingMonth',
          date: new Date(Date.UTC(2026, 4, 15)),
          billingMonth: null,
          billingYear: null,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
      ]);
      const ranged = await ledgerService.owedByMonthRange(userId, config.id, months[0], months[2]);
      for (const { month, year } of months) {
        const key = `${year}-${String(month).padStart(2, '0')}`;
        const single = await ledgerService.getMonthlyTotal(userId, config.id, month, year);
        const row = ranged.find((r) => r.monthKey === key);
        expect(row, `missing month ${key}`).toBeDefined();
        expect(row?.owed, `owed mismatch for ${key}`).toBeCloseTo(single.total, 2);
        expect(row?.borrowedCardTotal, `borrowedCardTotal mismatch for ${key}`).toBeCloseTo(
          single.borrowedCardTotal,
          2,
        );
      }
      expect(ranged.map((r) => r.monthKey)).toEqual(
        months.map(({ month, year }) => `${year}-${String(month).padStart(2, '0')}`),
      );
    });
  });
});
