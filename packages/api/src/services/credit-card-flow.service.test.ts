import type { DbExecutor } from '@fc/db';
import {
  accounts,
  creditCardConfigs,
  scheduledTransactions,
  transactions,
  userProfiles,
} from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { BillService } from './bill.service.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { MaterializationGuard } from './materialization-guard.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const flowService = new CreditCardFlowService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({
      email: 'cc-flow@test.com',
      name: 'Test',
      passwordHash: 'hash',
    })
    .returning();

  const expense = await accountService.create(user.id, {
    name: 'Expenses',
    type: 'expense',
    currency: 'BRL',
  });

  return { accountService, flowService, userId: user.id, expenseId: expense.id };
}

async function seedCardSetup(db: DbExecutor, opts: { closingDay: number; dueDay: number }) {
  const accountService = new AccountService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({
      email: 'cc-flow-setup@test.com',
      name: 'Test',
      passwordHash: 'hash',
    })
    .returning();

  const card = await accountService.create(user.id, {
    name: 'Credit Card',
    type: 'credit_card',
    currency: 'BRL',
  });

  const expense = await accountService.create(user.id, {
    name: 'Expenses',
    type: 'expense',
    currency: 'BRL',
  });

  await db.insert(creditCardConfigs).values({
    accountId: card.id,
    closingDay: opts.closingDay,
    dueDay: opts.dueDay,
  });

  return { userId: user.id, card, expense };
}

describe('CreditCardFlowService', () => {
  it('preserves purchase and posting dates separately from installment occurrence dates', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, expenseId } = await seed(db);
      const { account } = await flowService.createCreditCard(userId, {
        name: 'Dates',
        closingDay: 24,
        dueDay: 8,
      });
      const result = await flowService.addInstallment(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'Compra em junho',
        amount: '100.00',
        totalInstallments: 10,
        currentInstallmentNumber: 3,
        currentBillingMonth: 8,
        currentBillingYear: 2026,
        purchaseDate: '2026-06-12',
        purchaseDateSource: 'institution',
      });
      expect(result.schedule).toMatchObject({
        purchaseDate: '2026-06-12',
        purchaseDateSource: 'institution',
        startingOccurrence: 1,
      });
      const rows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, result.schedule.id));
      expect(rows).toHaveLength(10);
      expect(rows.find((row) => row.installmentNumber === 3)).toMatchObject({
        billingMonth: 8,
        billingYear: 2026,
        date: new Date('2026-08-08T00:00:00Z'),
      });
      expect(new Set(rows.map((row) => row.date.toISOString())).size).toBe(10);
    });
  });

  it('stores known purchase/posted dates and leaves unknown purchase metadata empty', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, expenseId } = await seed(db);
      const { account } = await flowService.createCreditCard(userId, {
        name: 'Dates',
        closingDay: 24,
        dueDay: 8,
      });
      const common = {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'Compra',
        amount: '100.00',
        billingMonth: 8,
        billingYear: 2026,
      };
      const known = await flowService.addOneTimeExpense(userId, {
        ...common,
        purchaseDate: '2026-08-13',
        postedDate: '2026-08-14',
        purchaseDateSource: 'institution',
        postedDateSource: 'institution',
      });
      expect(known.transaction).toMatchObject({
        purchaseDate: '2026-08-13',
        postedDate: '2026-08-14',
        purchaseDateSource: 'institution',
        postedDateSource: 'institution',
      });
      const unknown = await flowService.addOneTimeExpense(userId, common);
      expect(unknown.transaction).toMatchObject({
        purchaseDate: null,
        postedDate: null,
        purchaseDateSource: 'unknown',
        postedDateSource: 'unknown',
      });
    });
  });

  it('creates credit card with account + config', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { account, config } = await flowService.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
        creditLimit: '5000.00',
      });

      expect(account.type).toBe('credit_card');
      expect(account.name).toBe('Nubank');
      expect(config.closingDay).toBe(3);
      expect(config.dueDay).toBe(10);
    });
  });

  it('adds installment and materializes transactions (full series, past marked paid)', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, expenseId } = await seed(db);
      const { account } = await flowService.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      const { schedule, materialized, firstBillingMonth, firstBillingYear } =
        await flowService.addInstallment(userId, {
          creditCardAccountId: account.id,
          expenseAccountId: expenseId,
          description: 'TV Samsung',
          amount: '500.00',
          totalInstallments: 10,
          currentInstallmentNumber: 3,
          currentBillingMonth: 4,
          currentBillingYear: 2026,
        });

      expect(schedule.totalOccurrences).toBe(10);
      expect(schedule.startingOccurrence).toBe(1);
      expect(firstBillingMonth).toBe(2);
      expect(firstBillingYear).toBe(2026);
      expect(materialized.created).toBe(10);
    });
  });

  it('edits an installment: recomputes firstBilling, re-numbers, re-materializes, marks past paid', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, expenseId } = await seed(db);
      const { account } = await flowService.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      // Created WRONG (the bug): registered as parcela 1/3 in June, value 30.98
      // → firstBilling = June, series Jun(1/3)/Jul(2/3)/Aug(3/3).
      const { schedule } = await flowService.addInstallment(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'MERCADOL',
        amount: '30.98',
        totalInstallments: 3,
        currentInstallmentNumber: 1,
        currentBillingMonth: 6,
        currentBillingYear: 2026,
      });

      // Fix it: it is actually parcela 3/3 in June, value 30.99
      // → firstBilling = April, series Apr(1/3)/May(2/3)/Jun(3/3).
      const result = await flowService.editInstallment(userId, {
        scheduleId: schedule.id,
        description: 'MERCADOL',
        amount: '30.99',
        totalInstallments: 3,
        currentInstallmentNumber: 3,
        currentBillingMonth: 6,
        currentBillingYear: 2026,
      });

      expect(result.firstBillingMonth).toBe(4);
      expect(result.firstBillingYear).toBe(2026);

      const [updated] = await db
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      expect(updated.startingOccurrence).toBe(1);
      expect(updated.totalOccurrences).toBe(3);
      expect(updated.firstBillingMonth).toBe(4);
      expect(updated.firstBillingYear).toBe(2026);
      expect(updated.amount).toBe('30.99');

      const rows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));

      // Exactly the 3-parcela series — old Jul/Aug rows were purged, no dups.
      expect(rows).toHaveLength(3);
      const june = rows.find((r) => r.billingMonth === 6 && r.billingYear === 2026);
      expect(june?.installmentNumber).toBe(3);
      expect(june?.amount).toBe('30.99');
      expect(june?.isPaid).toBe(false);
      const past = rows.filter(
        (r) => (r.billingYear ?? 0) * 12 + (r.billingMonth ?? 0) < 2026 * 12 + 6,
      );
      expect(past).toHaveLength(2);
      expect(past.every((r) => r.isPaid)).toBe(true);
    });
  });

  it('editInstallment preserves paid past bill rows without duplicates', async () => {
    await withRollback(async (db) => {
      const { accountService, flowService, userId, expenseId } = await seed(db);
      const { account: card } = await flowService.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });
      const checking = await accountService.create(userId, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });

      const { schedule } = await flowService.addInstallment(userId, {
        creditCardAccountId: card.id,
        expenseAccountId: expenseId,
        description: 'TV Samsung',
        amount: '500.00',
        totalInstallments: 3,
        currentInstallmentNumber: 1,
        currentBillingMonth: 5,
        currentBillingYear: 2026,
      });

      const billService = new BillService(db, new MaterializationGuard(db));
      await billService.payBill(userId, card.id, 5, 2026, checking.id);

      const [mayBefore] = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.billingMonth, 5),
            eq(transactions.billingYear, 2026),
            eq(transactions.isReversed, false),
          ),
        );
      expect(mayBefore.isPaid).toBe(true);
      expect(mayBefore.paidAt).not.toBeNull();

      await flowService.editInstallment(userId, {
        scheduleId: schedule.id,
        description: 'TV Samsung 55',
        amount: '500.00',
        totalInstallments: 3,
        currentInstallmentNumber: 2,
        currentBillingMonth: 6,
        currentBillingYear: 2026,
      });

      const mayRows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.billingMonth, 5),
            eq(transactions.billingYear, 2026),
            eq(transactions.isReversed, false),
          ),
        );
      expect(mayRows).toHaveLength(1);
      expect(mayRows[0].id).toBe(mayBefore.id);
      expect(mayRows[0].isPaid).toBe(true);
      expect(mayRows[0].paidAt?.getTime()).toBe(mayBefore.paidAt?.getTime());
      expect(mayRows[0].paidFromAccountId).toBe(mayBefore.paidFromAccountId);

      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(rows).toHaveLength(3);
      const june = rows.find((r) => r.billingMonth === 6);
      expect(june?.description).toBe('TV Samsung 55');
      expect(june?.isPaid).toBe(false);
    });
  });

  it('editInstallment changes only open rows when a past bill is already paid', async () => {
    await withRollback(async (db) => {
      const { accountService, flowService, userId, expenseId } = await seed(db);
      const { account: card } = await flowService.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });
      const checking = await accountService.create(userId, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const { schedule } = await flowService.addInstallment(userId, {
        creditCardAccountId: card.id,
        expenseAccountId: expenseId,
        description: 'TV Samsung',
        amount: '500.00',
        totalInstallments: 3,
        currentInstallmentNumber: 1,
        currentBillingMonth: 5,
        currentBillingYear: 2026,
      });

      const billService = new BillService(db, new MaterializationGuard(db));
      await billService.payBill(userId, card.id, 5, 2026, checking.id);

      const [mayBefore] = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.billingMonth, 5),
            eq(transactions.billingYear, 2026),
            eq(transactions.isReversed, false),
          ),
        );

      await flowService.editInstallment(userId, {
        scheduleId: schedule.id,
        description: 'TV Samsung',
        amount: '600.00',
        totalInstallments: 3,
        currentInstallmentNumber: 2,
        currentBillingMonth: 6,
        currentBillingYear: 2026,
      });

      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      const may = rows.find((row) => row.billingMonth === 5);
      const june = rows.find((row) => row.billingMonth === 6);
      const july = rows.find((row) => row.billingMonth === 7);

      expect(may).toMatchObject({
        id: mayBefore.id,
        amount: '500.00',
        isPaid: true,
      });
      expect(june).toMatchObject({ amount: '600.00', isPaid: false });
      expect(july).toMatchObject({ amount: '600.00', isPaid: false });
    });
  });

  it('editInstallment reducing totalInstallments preserves paid rows beyond the new end', async () => {
    await withRollback(async (db) => {
      const { accountService, flowService, userId, expenseId } = await seed(db);
      const { account: card } = await flowService.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });
      const checking = await accountService.create(userId, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const { schedule } = await flowService.addInstallment(userId, {
        creditCardAccountId: card.id,
        expenseAccountId: expenseId,
        description: 'TV Samsung',
        amount: '500.00',
        totalInstallments: 3,
        currentInstallmentNumber: 1,
        currentBillingMonth: 5,
        currentBillingYear: 2026,
      });

      const billService = new BillService(db, new MaterializationGuard(db));
      await billService.payBill(userId, card.id, 7, 2026, checking.id);

      const [julyBefore] = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.billingMonth, 7),
            eq(transactions.billingYear, 2026),
            eq(transactions.isReversed, false),
          ),
        );
      expect(julyBefore.isPaid).toBe(true);

      await flowService.editInstallment(userId, {
        scheduleId: schedule.id,
        description: 'TV Samsung',
        amount: '500.00',
        totalInstallments: 2,
        currentInstallmentNumber: 2,
        currentBillingMonth: 6,
        currentBillingYear: 2026,
      });

      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(rows).toHaveLength(3);
      const installmentNumbers = rows
        .map((r) => r.installmentNumber)
        .sort((a, b) => (a ?? 0) - (b ?? 0));
      expect(installmentNumbers).toEqual([1, 2, 3]);
      const july = rows.find((r) => r.billingMonth === 7);
      expect(july?.id).toBe(julyBefore.id);
      expect(july?.isPaid).toBe(true);
      expect(july?.paidAt?.getTime()).toBe(julyBefore.paidAt?.getTime());
    });
  });

  it('adds fixed charge (recurring monthly)', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, expenseId } = await seed(db);
      const { account } = await flowService.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      const { schedule } = await flowService.addFixedCharge(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'Netflix',
        amount: '55.00',
        startDate: new Date(2026, 2, 15),
        dueDay: 15,
      });

      expect(schedule.isFixedCharge).toBe(true);
      expect(schedule.domainType).toBe('credit_card_fixed_charge');
    });
  });

  it('addOneTimeExpense forces the chosen fatura regardless of purchase date', async () => {
    await withRollback(async (db) => {
      const { userId, card, expense } = await seedCardSetup(db, { closingDay: 6, dueDay: 15 });
      const flow = new CreditCardFlowService(db);
      await flow.addOneTimeExpense(userId, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'IOF compra internacional',
        amount: '20.65',
        billingMonth: 6,
        billingYear: 2026,
        purchaseDate: new Date(2026, 5, 3),
      });
      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.userId, userId), eq(transactions.domainType, 'credit_card_expense')),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].billingMonth).toBe(6);
      expect(rows[0].billingYear).toBe(2026);
    });
  });

  it('addOneTimeExpense rejects an already-paid fatura', async () => {
    await withRollback(async (db) => {
      const { userId, card, expense } = await seedCardSetup(db, { closingDay: 6, dueDay: 15 });
      const flow = new CreditCardFlowService(db);
      await flow.addOneTimeExpense(userId, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'x',
        amount: '10.00',
        billingMonth: 6,
        billingYear: 2026,
      });
      await db
        .update(transactions)
        .set({ isPaid: true, paidAt: new Date() })
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.billingMonth, 6),
            eq(transactions.billingYear, 2026),
          ),
        );
      await expect(
        flow.addOneTimeExpense(userId, {
          creditCardAccountId: card.id,
          expenseAccountId: expense.id,
          description: 'y',
          amount: '5.00',
          billingMonth: 6,
          billingYear: 2026,
        }),
      ).rejects.toThrow(/paga|paid/i);
    });
  });

  it('addOneTimeExpense rejects a paid fatura even when an unpaid refund row is present', async () => {
    await withRollback(async (db) => {
      const { userId, card, expense } = await seedCardSetup(db, { closingDay: 6, dueDay: 15 });
      const flow = new CreditCardFlowService(db);
      await flow.addOneTimeExpense(userId, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'x',
        amount: '10.00',
        billingMonth: 6,
        billingYear: 2026,
      });

      // A refund credits the card and is stored unpaid (is_paid=false). It must NOT
      // be counted by the paid-fatura guard, or it would mask an otherwise-settled
      // fatura and wrongly allow a new charge.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expense.id,
        destinationAccountId: card.id,
        amount: '5.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Refund',
        date: new Date(2026, 5, 4),
        billingMonth: 6,
        billingYear: 2026,
        domainType: 'credit_card_refund',
        isPaid: false,
      });

      // Pay only the non-refund charge → fatura is settled.
      await db
        .update(transactions)
        .set({ isPaid: true, paidAt: new Date() })
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.billingMonth, 6),
            eq(transactions.billingYear, 2026),
            eq(transactions.domainType, 'credit_card_expense'),
          ),
        );

      await expect(
        flow.addOneTimeExpense(userId, {
          creditCardAccountId: card.id,
          expenseAccountId: expense.id,
          description: 'y',
          amount: '5.00',
          billingMonth: 6,
          billingYear: 2026,
        }),
      ).rejects.toThrow(/paga|paid/i);
    });
  });

  it('addRefund creates a card credit in the selected open fatura', async () => {
    await withRollback(async (db) => {
      const { userId, card, expense } = await seedCardSetup(db, { closingDay: 6, dueDay: 15 });
      const flow = new CreditCardFlowService(db);
      const refundDate = new Date('2026-08-28T12:00:00.000Z');

      const { transaction } = await flow.addRefund(userId, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Adiantamento de fatura',
        amount: '100.00',
        billingMonth: 8,
        billingYear: 2026,
        refundDate,
      });

      expect(transaction).toMatchObject({
        userId,
        sourceAccountId: expense.id,
        destinationAccountId: card.id,
        amount: '100.00',
        description: 'Adiantamento de fatura',
        billingMonth: 8,
        billingYear: 2026,
        domainType: 'credit_card_refund',
        isPaid: false,
      });
      expect(transaction.date.toISOString().slice(0, 10)).toBe('2026-08-28');
    });
  });

  it('addRefund rejects settled faturas, archived cards, and foreign accounts', async () => {
    await withRollback(async (db) => {
      const { userId, card, expense } = await seedCardSetup(db, { closingDay: 6, dueDay: 15 });
      const flow = new CreditCardFlowService(db);
      await flow.addOneTimeExpense(userId, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Settled charge',
        amount: '10.00',
        billingMonth: 8,
        billingYear: 2026,
      });
      await db
        .update(transactions)
        .set({ isPaid: true, paidAt: new Date() })
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.billingMonth, 8),
            eq(transactions.billingYear, 2026),
          ),
        );

      const refund = {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Blocked refund',
        amount: '5.00',
        billingMonth: 8,
        billingYear: 2026,
      };
      await expect(flow.addRefund(userId, refund)).rejects.toThrow(/paga|paid/i);

      await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, card.id));
      await expect(flow.addRefund(userId, { ...refund, billingMonth: 9 })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'CARD_ARCHIVED',
      });

      const [otherUser] = await db
        .insert(userProfiles)
        .values({
          email: 'cc-refund-foreign@test.com',
          name: 'Other',
          passwordHash: 'hash',
        })
        .returning();
      const foreignExpense = await new AccountService(db).create(otherUser.id, {
        name: 'Foreign Expenses',
        type: 'expense',
        currency: 'BRL',
      });
      await db.update(accounts).set({ isActive: true }).where(eq(accounts.id, card.id));
      await expect(
        flow.addRefund(userId, {
          ...refund,
          expenseAccountId: foreignExpense.id,
          billingMonth: 9,
        }),
      ).rejects.toThrow(/not found|não encontrada/i);
    });
  });

  it('addFixedCharge with firstBilling starts the series on the chosen fatura', async () => {
    await withRollback(async (db) => {
      const { userId, card, expense } = await seedCardSetup(db, { closingDay: 6, dueDay: 15 });
      const flow = new CreditCardFlowService(db);
      await flow.addFixedCharge(userId, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Assinatura',
        amount: '37.80',
        startDate: new Date(2026, 5, 1),
        dueDay: 15,
        firstBillingMonth: 6,
        firstBillingYear: 2026,
      });
      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.domainType, 'credit_card_fixed_charge'),
          ),
        );
      const billings = rows.map((r) => `${r.billingYear}-${r.billingMonth}`);
      expect(billings).toContain('2026-6');
    });
  });

  it('rejects card writes after the card group is archived', async () => {
    await withRollback(async (db) => {
      const { userId, card, expense } = await seedCardSetup(db, { closingDay: 6, dueDay: 15 });
      const flow = new CreditCardFlowService(db);
      await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, card.id));

      await expect(
        flow.addOneTimeExpense(userId, {
          creditCardAccountId: card.id,
          expenseAccountId: expense.id,
          description: 'Blocked',
          amount: '10.00',
          billingMonth: 7,
          billingYear: 2026,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'CARD_ARCHIVED' });

      await expect(
        flow.upsertConfig(userId, {
          accountId: card.id,
          closingDay: 8,
          dueDay: 16,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'CARD_ARCHIVED' });
    });
  });
});
