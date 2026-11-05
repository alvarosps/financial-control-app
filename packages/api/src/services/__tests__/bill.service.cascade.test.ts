import type { DbExecutor } from '@fc/db';
import { transactions, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../../test/with-rollback.ts';
import { AccountService } from '../account.service.ts';
import { BillService } from '../bill.service.ts';
import { CreditCardFlowService } from '../credit-card-flow.service.ts';
import { MaterializationGuard } from '../materialization-guard.service.ts';
import { WalletCashService } from '../wallet-cash.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const ccFlow = new CreditCardFlowService(db);
  const billService = new BillService(db, new MaterializationGuard(db));
  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'cascade@test.com', name: 'Test', passwordHash: 'hash' })
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
  const { account: parent } = await ccFlow.createCreditCard(userId, {
    name: 'C6',
    closingDay: 3,
    dueDay: 10,
  });
  const child = await accountService.create(userId, {
    name: 'C6 - Camila',
    type: 'credit_card',
    currency: 'BRL',
    parentAccountId: parent.id,
  });
  return {
    accountService,
    ccFlow,
    billService,
    userId,
    checkingId: checking.id,
    expenseId: expense.id,
    parentId: parent.id,
    childId: child.id,
  };
}

function charge(
  userId: string,
  expenseId: string,
  cardId: string,
  amount: string,
): typeof transactions.$inferInsert {
  return {
    userId,
    sourceAccountId: expenseId,
    destinationAccountId: cardId,
    amount,
    currency: 'BRL',
    type: 'withdrawal' as const,
    description: 'x',
    date: new Date(2026, 5, 5),
    billingMonth: 6,
    billingYear: 2026,
    domainType: 'credit_card_expense',
    isPaid: false,
  };
}

describe('BillService.payBill — additional-card cascade', () => {
  it('paying the principal also settles its additional (child) card in one go', async () => {
    await withRollback(async (db) => {
      const { billService, userId, checkingId, expenseId, parentId, childId } = await seed(db);
      await db
        .insert(transactions)
        .values([
          charge(userId, expenseId, parentId, '1000.00'),
          charge(userId, expenseId, childId, '500.00'),
        ]);

      const result = await billService.payBill(userId, parentId, 6, 2026, checkingId);

      expect(result.paidCardCount).toBe(2);
      expect(result.markedCount).toBe(2);
      expect(result.billTotal).toBe('1500.00');
      expect((await new WalletCashService(db).getWalletCash(userId)).totalCash).toBe(-1500);

      expect((await billService.getBill(userId, parentId, 6, 2026)).isPaid).toBe(true);
      expect((await billService.getBill(userId, childId, 6, 2026)).isPaid).toBe(true);
      expect((await billService.getConsolidatedBill(userId, parentId, 6, 2026)).isPaid).toBe(true);
    });
  });

  it('skips a child with nothing to pay without aborting the principal payment', async () => {
    await withRollback(async (db) => {
      const { billService, userId, checkingId, expenseId, parentId } = await seed(db);
      // Only the principal has charges; the child fatura is empty this month.
      await db.insert(transactions).values([charge(userId, expenseId, parentId, '1000.00')]);

      const result = await billService.payBill(userId, parentId, 6, 2026, checkingId);

      expect(result.paidCardCount).toBe(1);
      expect(result.billTotal).toBe('1000.00');
      expect((await billService.getBill(userId, parentId, 6, 2026)).isPaid).toBe(true);
      // Empty child + paid principal → consolidated reads as paid.
      expect((await billService.getConsolidatedBill(userId, parentId, 6, 2026)).isPaid).toBe(true);
    });
  });

  it('paying a child card directly settles only that child, not the principal', async () => {
    await withRollback(async (db) => {
      const { billService, userId, checkingId, expenseId, parentId, childId } = await seed(db);
      await db
        .insert(transactions)
        .values([
          charge(userId, expenseId, parentId, '1000.00'),
          charge(userId, expenseId, childId, '500.00'),
        ]);

      const result = await billService.payBill(userId, childId, 6, 2026, checkingId);

      expect(result.paidCardCount).toBe(1);
      expect(result.billTotal).toBe('500.00');
      expect((await billService.getBill(userId, childId, 6, 2026)).isPaid).toBe(true);
      expect((await billService.getBill(userId, parentId, 6, 2026)).isPaid).toBe(false);
      // Principal still unpaid → consolidated stays unpaid.
      expect((await billService.getConsolidatedBill(userId, parentId, 6, 2026)).isPaid).toBe(false);
    });
  });

  it('re-paying a principal after a child charge is added post-payment settles only the new child', async () => {
    await withRollback(async (db) => {
      const { billService, userId, checkingId, expenseId, parentId, childId } = await seed(db);
      // First: only the principal has a charge; pay it.
      await db.insert(transactions).values([charge(userId, expenseId, parentId, '1000.00')]);
      const first = await billService.payBill(userId, parentId, 6, 2026, checkingId);
      expect(first.paidCardCount).toBe(1);
      expect((await billService.getConsolidatedBill(userId, parentId, 6, 2026)).isPaid).toBe(true);

      // A child charge arrives later (e.g. mid-month additional-card purchase).
      await db.insert(transactions).values([charge(userId, expenseId, childId, '50.00')]);
      // Consolidated flips back to unpaid because the child now owes.
      expect((await billService.getConsolidatedBill(userId, parentId, 6, 2026)).isPaid).toBe(false);

      // Re-paying the principal must settle ONLY the child (principal already
      // paid is skipped, not a CONFLICT/"nothing to pay"), summing to the child.
      const second = await billService.payBill(userId, parentId, 6, 2026, checkingId);
      expect(second.paidCardCount).toBe(1);
      expect(second.markedCount).toBe(1);
      expect(second.billTotal).toBe('50.00');
      expect((await billService.getConsolidatedBill(userId, parentId, 6, 2026)).isPaid).toBe(true);
    });
  });

  it('rejects with "nothing to pay" once principal + all children are already settled', async () => {
    await withRollback(async (db) => {
      const { billService, userId, checkingId, expenseId, parentId, childId } = await seed(db);
      await db
        .insert(transactions)
        .values([
          charge(userId, expenseId, parentId, '1000.00'),
          charge(userId, expenseId, childId, '500.00'),
        ]);

      await billService.payBill(userId, parentId, 6, 2026, checkingId);

      await expect(billService.payBill(userId, parentId, 6, 2026, checkingId)).rejects.toThrow(
        'Não há valor pendente nesta fatura',
      );
    });
  });
});
