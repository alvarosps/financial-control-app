import type { DbExecutor } from '@fc/db';
import { accounts, creditCardBills, transactions, userProfiles } from '@fc/db';
import { computeFaturaDueDate } from '@fc/domain';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { BillService } from './bill.service.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { MaterializationGuard } from './materialization-guard.service.ts';
import { SettlementService } from './settlement.service.ts';
import { TransactionService } from './transaction.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const ccFlow = new CreditCardFlowService(db);
  const billService = new BillService(db, new MaterializationGuard(db));

  const [user] = await db
    .insert(userProfiles)
    .values({
      email: 'bill@test.com',
      name: 'Test',
      passwordHash: 'hash',
    })
    .returning();

  const checking = await accountService.create(user.id, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  const expense = await accountService.create(user.id, {
    name: 'Food',
    type: 'expense',
    currency: 'BRL',
  });

  return {
    accountService,
    ccFlow,
    billService,
    userId: user.id,
    checkingId: checking.id,
    expenseId: expense.id,
  };
}

describe('BillService', () => {
  it('settles exactly one wallet outflow with the same payment timestamp and blocks unsafe undo', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId, expenseId } = await seed(db);
      await db
        .update(accounts)
        .set({
          openingBalance: '1000.00',
          openingBalanceAnchorAt: new Date('2026-01-01T00:00:00Z'),
        })
        .where(eq(accounts.id, checkingId));
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Card',
        closingDay: 3,
        dueDay: 10,
      });
      await ccFlow.addOneTimeExpense(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'Groceries',
        amount: '100.00',
        billingMonth: 6,
        billingYear: 2026,
      });
      const cash = new WalletCashService(db);
      expect((await cash.getWalletCash(userId)).totalCash).toBe(1000);
      await billService.payBill(userId, account.id, 6, 2026, checkingId);
      expect((await cash.getWalletCash(userId)).totalCash).toBe(900);
      const [payment] = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.domainType, 'bill_payment')));
      const [bill] = await db
        .select()
        .from(creditCardBills)
        .where(eq(creditCardBills.creditCardAccountId, account.id));
      expect(payment).toMatchObject({
        isPaid: true,
        amount: '100.00',
        paidFromAccountId: checkingId,
        sourceAccountId: checkingId,
        destinationAccountId: account.id,
      });
      expect(payment.paidAt?.toISOString().slice(0, 10)).toBe(
        payment.date.toISOString().slice(0, 10),
      );
      expect(bill.paidAt).toEqual(payment.settlementDate);
      expect(payment.paidAt?.getTime()).toBeGreaterThanOrEqual(
        payment.settlementDate?.getTime() ?? 0,
      );
      const originalPayment = payment;
      await expect(billService.payBill(userId, account.id, 6, 2026, checkingId)).rejects.toThrow();
      await expect(new TransactionService(db).reverse(userId, payment.id)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(new SettlementService(db).unsettle(userId, payment.id)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(
        new SettlementService(db).settle(userId, {
          transactionId: payment.id,
          walletAccountId: checkingId,
          leg: 'source',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await new TransactionService(db).getById(userId, payment.id)).toEqual(originalPayment);
      expect((await cash.getWalletCash(userId)).totalCash).toBe(900);
    });
  });

  it('debits only the remaining unpaid charges without changing previously settled charges', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Partial',
        closingDay: 3,
        dueDay: 10,
      });
      const paidAt = new Date('2026-05-01T12:00:00Z');
      await ccFlow.addOneTimeExpense(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'Remaining',
        amount: '40.00',
        billingMonth: 6,
        billingYear: 2026,
      });
      const [previous] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '60.00',
          type: 'withdrawal',
          domainType: 'credit_card_expense',
          description: 'Previously settled',
          date: paidAt,
          billingMonth: 6,
          billingYear: 2026,
          isPaid: true,
          paidAt,
          paidFromAccountId: checkingId,
        })
        .returning();
      const result = await billService.payBill(userId, account.id, 6, 2026, checkingId);
      expect(result.billTotal).toBe('40.00');
      expect((await new WalletCashService(db).getWalletCash(userId)).totalCash).toBe(-40);
      expect(await new TransactionService(db).getById(userId, previous.id)).toEqual(previous);
    });
  });

  it.each([
    'expense',
    'savings',
    'USD',
    'inactive',
    'future-anchor',
  ] as const)('rejects an incompatible %s payment wallet atomically', async (kind) => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Card',
        closingDay: 3,
        dueDay: 10,
      });
      await ccFlow.addOneTimeExpense(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'Groceries',
        amount: '100.00',
        billingMonth: 6,
        billingYear: 2026,
      });
      await db
        .update(accounts)
        .set(
          kind === 'USD'
            ? { currency: 'USD' }
            : kind === 'inactive'
              ? { isActive: false }
              : kind === 'future-anchor'
                ? { openingBalanceAnchorAt: new Date('2099-01-01T00:00:00Z') }
                : { type: kind },
        )
        .where(eq(accounts.id, checkingId));
      await expect(
        billService.payBill(userId, account.id, 6, 2026, checkingId),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(
        await db
          .select()
          .from(transactions)
          .where(and(eq(transactions.userId, userId), eq(transactions.domainType, 'bill_payment'))),
      ).toHaveLength(0);
      expect((await billService.getBill(userId, account.id, 6, 2026)).isPaid).toBe(false);
    });
  });

  it('gets bill total for a billing period', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      await ccFlow.addInstallment(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'TV',
        amount: '500.00',
        totalInstallments: 3,
        currentInstallmentNumber: 1,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      });

      const bill = await billService.getBill(userId, account.id, 4, 2026);

      expect(bill.total).toBe(500);
      expect(bill.transactionCount).toBe(1);
      expect(bill.isPaid).toBe(false);
    });
  });

  it('pays bill and marks transactions as paid', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      await ccFlow.addInstallment(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'TV',
        amount: '500.00',
        totalInstallments: 3,
        currentInstallmentNumber: 1,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      });

      const result = await billService.payBill(userId, account.id, 4, 2026, checkingId);

      expect(result.billTotal).toBe('500.00');
      expect(result.markedCount).toBe(1);

      const bill = await billService.getBill(userId, account.id, 4, 2026);
      expect(bill.isPaid).toBe(true);
    });
  });

  it('rejects paying an archived card while preserving bill consultation', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Archived',
        closingDay: 3,
        dueDay: 10,
      });
      await ccFlow.addOneTimeExpense(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'Historical',
        amount: '50.00',
        billingMonth: 4,
        billingYear: 2026,
      });
      await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, account.id));

      await expect(
        billService.payBill(userId, account.id, 4, 2026, checkingId),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'CARD_ARCHIVED' });
      await expect(billService.getBill(userId, account.id, 4, 2026)).resolves.toMatchObject({
        total: 50,
      });
    });
  });

  it('returns empty bill for month with no transactions', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      const bill = await billService.getBill(userId, account.id, 6, 2026);

      expect(bill.total).toBe(0);
      expect(bill.transactionCount).toBe(0);
    });
  });

  it('gets bill summary for all cards', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId } = await seed(db);
      await ccFlow.createCreditCard(userId, { name: 'Nubank', closingDay: 3, dueDay: 10 });
      await ccFlow.createCreditCard(userId, { name: 'Bradesco', closingDay: 20, dueDay: 25 });

      const summary = await billService.getBillSummary(userId);

      expect(summary).toHaveLength(2);
      expect(summary[0].cardName).toBeDefined();
      expect(summary[0].currentBill).toBeDefined();
      expect(summary[0].nextBillPreview).toBeDefined();
    });
  });

  it('rejects second sequential payment with "no unpaid amount" (first marked bill as paid)', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      await ccFlow.addInstallment(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'TV',
        amount: '500.00',
        totalInstallments: 1,
        currentInstallmentNumber: 1,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      });

      await billService.payBill(userId, account.id, 4, 2026, checkingId);

      await expect(billService.payBill(userId, account.id, 4, 2026, checkingId)).rejects.toThrow(
        'Não há valor pendente nesta fatura',
      );
    });
  });

  it('aggregates current-month bills for multiple cards with mixed paid state', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, expenseId } = await seed(db);

      const { account: card1 } = await ccFlow.createCreditCard(userId, {
        name: 'Card1',
        closingDay: 3,
        dueDay: 10,
      });
      const { account: card2 } = await ccFlow.createCreditCard(userId, {
        name: 'Card2',
        closingDay: 3,
        dueDay: 15,
      });

      const now = new Date();
      const curMonth = now.getMonth() + 1;
      const curYear = now.getFullYear();

      // card1: 2 unpaid (100 + 50)
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: card1.id,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'c1-a',
          date: new Date(curYear, curMonth - 1, 5),
          billingMonth: curMonth,
          billingYear: curYear,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: card1.id,
          amount: '50.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'c1-b',
          date: new Date(curYear, curMonth - 1, 6),
          billingMonth: curMonth,
          billingYear: curYear,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
      ]);

      // card2: 1 paid (200)
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expenseId,
        destinationAccountId: card2.id,
        amount: '200.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'c2-a',
        date: new Date(curYear, curMonth - 1, 7),
        billingMonth: curMonth,
        billingYear: curYear,
        domainType: 'credit_card_expense',
        isPaid: true,
        paidAt: new Date(),
      });

      const result = await billService.getBillSummary(userId);
      expect(result).toHaveLength(2);

      const r1 = result.find((r) => r.cardId === card1.id);
      const r2 = result.find((r) => r.cardId === card2.id);
      if (!r1 || !r2) throw new Error('expected both cards in summary');

      expect(r1.currentBill.total).toBe(150);
      expect(r1.currentBill.transactionCount).toBe(2);
      expect(r1.currentBill.isPaid).toBe(false);

      expect(r2.currentBill.total).toBe(200);
      expect(r2.currentBill.isPaid).toBe(true);
    });
  });

  it('consolidates an additional card into its parent (parents-only, summed)', async () => {
    await withRollback(async (db) => {
      const { accountService, ccFlow, billService, userId, expenseId } = await seed(db);
      const { account: parent } = await ccFlow.createCreditCard(userId, {
        name: 'Azul',
        closingDay: 6,
        dueDay: 13,
      });
      const child = await accountService.create(userId, {
        name: 'Azul Camila',
        type: 'credit_card',
        currency: 'BRL',
        parentAccountId: parent.id,
      });

      const now = new Date();
      const m = now.getMonth() + 1;
      const y = now.getFullYear();
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: parent.id,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'p1',
          date: new Date(y, m - 1, 5),
          billingMonth: m,
          billingYear: y,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: child.id,
          amount: '40.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'c1',
          date: new Date(y, m - 1, 6),
          billingMonth: m,
          billingYear: y,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
      ]);

      const summary = await billService.getBillSummary(userId);
      expect(summary.find((s) => s.cardId === child.id)).toBeUndefined();
      const azul = summary.find((s) => s.cardId === parent.id);
      if (!azul) throw new Error('parent missing');
      expect(azul.currentBill.total).toBe(140);
      expect(azul.currentBill.transactionCount).toBe(2);
    });
  });

  it('subtracts credit_card_refund rows from the bill total', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });
      await ccFlow.addInstallment(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'TV',
        amount: '500.00',
        totalInstallments: 1,
        currentInstallmentNumber: 1,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      });
      // a refund/estorno in the same bill
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expenseId,
        destinationAccountId: account.id,
        amount: '120.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Estorno Amazon',
        date: new Date(2026, 3, 15),
        billingMonth: 4,
        billingYear: 2026,
        domainType: 'credit_card_refund',
        isPaid: false,
      });

      const bill = await billService.getBill(userId, account.id, 4, 2026);
      expect(bill.total).toBe(380); // 500 − 120
      expect(bill.unpaidTotal).toBe(380);
      expect(bill.isPaid).toBe(false);
    });
  });

  it('payBill charges the net of refunds and leaves the refund row unpaid', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });
      await ccFlow.addInstallment(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'TV',
        amount: '500.00',
        totalInstallments: 1,
        currentInstallmentNumber: 1,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expenseId,
        destinationAccountId: account.id,
        amount: '120.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Estorno',
        date: new Date(2026, 3, 15),
        billingMonth: 4,
        billingYear: 2026,
        domainType: 'credit_card_refund',
        isPaid: false,
      });

      const result = await billService.payBill(userId, account.id, 4, 2026, checkingId);
      expect(result.billTotal).toBe('380.00'); // pays 500 − 120
      expect((await new WalletCashService(db).getWalletCash(userId)).totalCash).toBe(-380);
      expect(result.markedCount).toBe(1); // only the charge marked paid

      const bill = await billService.getBill(userId, account.id, 4, 2026);
      expect(bill.total).toBe(380);
      expect(bill.isPaid).toBe(true);

      const [refundRow] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.domainType, 'credit_card_refund'));
      expect(refundRow.isPaid).toBe(false); // refunds are credits, never marked paid
    });
  });

  it('getBill reports a negative total when refunds exceed charges (credit balance)', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Amazon',
        closingDay: 3,
        dueDay: 10,
      });
      await ccFlow.addInstallment(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'Compra',
        amount: '100.70',
        totalInstallments: 1,
        currentInstallmentNumber: 1,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      });
      // "Saldo Anterior" credit larger than the month's charges
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expenseId,
        destinationAccountId: account.id,
        amount: '220.62',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Saldo Anterior',
        date: new Date(2026, 3, 2),
        billingMonth: 4,
        billingYear: 2026,
        domainType: 'credit_card_refund',
        isPaid: false,
      });

      const bill = await billService.getBill(userId, account.id, 4, 2026);
      expect(bill.total).toBeCloseTo(-119.92, 2); // 100.70 − 220.62
      expect(bill.unpaidTotal).toBeCloseTo(-119.92, 2);
      expect(bill.isPaid).toBe(false);
    });
  });

  it('payBill on a credit bill rejects with "nothing to pay" (not an invariant error)', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Amazon',
        closingDay: 3,
        dueDay: 10,
      });
      await ccFlow.addInstallment(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'Compra',
        amount: '100.70',
        totalInstallments: 1,
        currentInstallmentNumber: 1,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expenseId,
        destinationAccountId: account.id,
        amount: '220.62',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Saldo Anterior',
        date: new Date(2026, 3, 2),
        billingMonth: 4,
        billingYear: 2026,
        domainType: 'credit_card_refund',
        isPaid: false,
      });

      // A negative net total is a legitimate credit, not data corruption: the
      // pay flow must refuse politely ("nothing to pay"), never blow up with an
      // InvariantViolationError.
      await expect(billService.payBill(userId, account.id, 4, 2026, checkingId)).rejects.toThrow(
        'valor pendente',
      );
      expect((await new WalletCashService(db).getWalletCash(userId)).totalCash).toBe(0);
    });
  });

  it('getBillSummary subtracts refunds from the card total', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });
      const now = new Date();
      const m = now.getMonth() + 1;
      const y = now.getFullYear();
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '300.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'compra',
          date: new Date(y, m - 1, 5),
          billingMonth: m,
          billingYear: y,
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
          description: 'estorno',
          date: new Date(y, m - 1, 6),
          billingMonth: m,
          billingYear: y,
          domainType: 'credit_card_refund',
          isPaid: false,
        },
      ]);

      const summary = await billService.getBillSummary(userId);
      const card = summary.find((s) => s.cardId === account.id);
      if (!card) throw new Error('card missing');
      expect(card.currentBill.total).toBe(250); // 300 − 50
    });
  });

  it('rejects paying bill with zero unpaid amount', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      await expect(billService.payBill(userId, account.id, 4, 2026, checkingId)).rejects.toThrow(
        'valor pendente',
      );
    });
  });

  describe('getBillForMonth', () => {
    it('returns the consolidated per-card fatura for an arbitrary month', async () => {
      await withRollback(async (db) => {
        const { ccFlow, billService, userId, expenseId } = await seed(db);
        const { account } = await ccFlow.createCreditCard(userId, {
          name: 'Nubank',
          closingDay: 3,
          dueDay: 10,
        });
        // A charge billed to July 2026 — outside the current calendar month.
        await db.insert(transactions).values([
          {
            userId,
            sourceAccountId: expenseId,
            destinationAccountId: account.id,
            amount: '300.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'compra',
            date: new Date(2026, 6, 5),
            billingMonth: 7,
            billingYear: 2026,
            domainType: 'credit_card_expense',
            isPaid: false,
          },
          // A bill_payment transfer must be excluded from the total.
          {
            userId,
            sourceAccountId: expenseId,
            destinationAccountId: account.id,
            amount: '300.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Pagamento fatura',
            date: new Date(2026, 6, 6),
            billingMonth: 7,
            billingYear: 2026,
            domainType: 'bill_payment',
            isPaid: true,
          },
        ]);

        const bills = await billService.getBillForMonth(userId, 7, 2026);
        const card = bills.find((b) => b.cardId === account.id);
        if (!card) throw new Error('card missing');
        expect(card.month).toBe(7);
        expect(card.year).toBe(2026);
        expect(card.total).toBe(300);
        expect(card.dueDay).toBe(10);
        expect(card.isPaid).toBe(false);
      });
    });

    it('subtracts refunds and folds children into the parent fatura', async () => {
      await withRollback(async (db) => {
        const { ccFlow, billService, accountService, userId, expenseId } = await seed(db);
        const { account: parent } = await ccFlow.createCreditCard(userId, {
          name: 'Itaú',
          closingDay: 3,
          dueDay: 15,
        });
        const child = await accountService.create(userId, {
          name: 'Itaú Adicional',
          type: 'credit_card',
          currency: 'BRL',
          parentAccountId: parent.id,
        });
        await db.insert(transactions).values([
          {
            userId,
            sourceAccountId: expenseId,
            destinationAccountId: parent.id,
            amount: '400.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'compra parent',
            date: new Date(2026, 7, 5),
            billingMonth: 8,
            billingYear: 2026,
            domainType: 'credit_card_expense',
            isPaid: false,
          },
          {
            userId,
            sourceAccountId: expenseId,
            destinationAccountId: child.id,
            amount: '100.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'compra child',
            date: new Date(2026, 7, 6),
            billingMonth: 8,
            billingYear: 2026,
            domainType: 'credit_card_expense',
            isPaid: false,
          },
          {
            userId,
            sourceAccountId: expenseId,
            destinationAccountId: parent.id,
            amount: '50.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'estorno',
            date: new Date(2026, 7, 7),
            billingMonth: 8,
            billingYear: 2026,
            domainType: 'credit_card_refund',
            isPaid: false,
          },
        ]);

        const bills = await billService.getBillForMonth(userId, 8, 2026);
        // Only the parent appears (children fold in).
        expect(bills.some((b) => b.cardId === child.id)).toBe(false);
        const card = bills.find((b) => b.cardId === parent.id);
        if (!card) throw new Error('parent card missing');
        expect(card.total).toBe(450); // 400 + 100 − 50
        expect(card.dueDay).toBe(15);
      });
    });

    it('computes dueDate next-month when dueDay <= closingDay', async () => {
      await withRollback(async (db) => {
        const { ccFlow, billService, userId, expenseId } = await seed(db);
        // close 28 / due 3 → dueDay <= closingDay → due in the month AFTER billingMonth.
        const { account } = await ccFlow.createCreditCard(userId, {
          name: 'Azul',
          closingDay: 28,
          dueDay: 3,
        });
        await db.insert(transactions).values({
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '300.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'compra',
          date: new Date(2026, 5, 5),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
          isPaid: false,
        });

        const bills = await billService.getBillForMonth(userId, 6, 2026);
        const card = bills.find((b) => b.cardId === account.id);
        if (!card) throw new Error('card missing');
        expect(card.dueDay).toBe(3);
        expect(card.dueDate).toBe('2026-07-03'); // next month
      });
    });

    it('computes dueDate same-month when dueDay > closingDay', async () => {
      await withRollback(async (db) => {
        const { ccFlow, billService, userId, expenseId } = await seed(db);
        // close 10 / due 20 → dueDay > closingDay → due in the SAME month as billingMonth.
        const { account } = await ccFlow.createCreditCard(userId, {
          name: 'Bradesco',
          closingDay: 10,
          dueDay: 20,
        });
        await db.insert(transactions).values({
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '120.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'compra',
          date: new Date(2026, 5, 5),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
          isPaid: false,
        });

        const bills = await billService.getBillForMonth(userId, 6, 2026);
        const card = bills.find((b) => b.cardId === account.id);
        if (!card) throw new Error('card missing');
        expect(card.dueDay).toBe(20);
        expect(card.dueDate).toBe('2026-06-20'); // same month
      });
    });
  });

  describe('getBillSummary dueDate', () => {
    it('exposes currentBill.dueDate for both next-month and same-month cards', async () => {
      await withRollback(async (db) => {
        const { ccFlow, billService, userId, expenseId } = await seed(db);
        const now = new Date();
        const m = now.getMonth() + 1;
        const y = now.getFullYear();

        // Next-month card: close 28 / due 3 → dueDay <= closingDay.
        const { account: nextCard } = await ccFlow.createCreditCard(userId, {
          name: 'NextMonth',
          closingDay: 28,
          dueDay: 3,
        });
        // Same-month card: close 10 / due 20 → dueDay > closingDay.
        const { account: sameCard } = await ccFlow.createCreditCard(userId, {
          name: 'SameMonth',
          closingDay: 10,
          dueDay: 20,
        });

        await db.insert(transactions).values([
          {
            userId,
            sourceAccountId: expenseId,
            destinationAccountId: nextCard.id,
            amount: '100.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'n1',
            date: new Date(y, m - 1, 5),
            billingMonth: m,
            billingYear: y,
            domainType: 'credit_card_expense',
            isPaid: false,
          },
          {
            userId,
            sourceAccountId: expenseId,
            destinationAccountId: sameCard.id,
            amount: '50.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 's1',
            date: new Date(y, m - 1, 6),
            billingMonth: m,
            billingYear: y,
            domainType: 'credit_card_expense',
            isPaid: false,
          },
        ]);

        const toIso = (d: Date) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
            d.getDate(),
          ).padStart(2, '0')}`;

        const summary = await billService.getBillSummary(userId);
        const next = summary.find((s) => s.cardId === nextCard.id);
        const same = summary.find((s) => s.cardId === sameCard.id);
        if (!next || !same) throw new Error('expected both cards in summary');

        expect(next.currentBill.dueDate).toBe(toIso(computeFaturaDueDate(m, y, 3, 28)));
        expect(same.currentBill.dueDate).toBe(toIso(computeFaturaDueDate(m, y, 20, 10)));
      });
    });
  });
});
