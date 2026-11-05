import type { DbExecutor } from '@fc/db';
import { accounts, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../../test/with-rollback.ts';
import { AccountService } from '../account.service.ts';
import { BillService } from '../bill.service.ts';
import { CreditCardFlowService } from '../credit-card-flow.service.ts';
import { MaterializationGuard } from '../materialization-guard.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const ccFlow = new CreditCardFlowService(db);
  const billService = new BillService(db, new MaterializationGuard(db));
  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'consolidated@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();
  const userId = user.id;
  const expense = await accountService.create(userId, {
    name: 'Food',
    type: 'expense',
    currency: 'BRL',
  });
  return { accountService, ccFlow, billService, userId, expenseId: expense.id };
}

function tx(
  userId: string,
  expenseId: string,
  cardId: string,
  amount: string,
  domainType: (typeof transactions.$inferInsert)['domainType'],
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
    domainType,
    isPaid: false,
  };
}

describe('BillService.getConsolidatedBill', () => {
  it.each([
    {
      name: 'refund on the same card',
      paid: false,
      refund: 100,
      childCharge: 0,
      childRefund: 0,
      total: 400,
      pending: 400,
    },
    {
      name: 'paid principal with unpaid child',
      paid: true,
      refund: 0,
      childCharge: 300,
      childRefund: 0,
      total: 800,
      pending: 300,
    },
    {
      name: 'credit on a different card',
      paid: false,
      refund: 0,
      childCharge: 0,
      childRefund: 100,
      total: 400,
      pending: 500,
    },
    {
      name: 'net credit',
      paid: false,
      refund: 600,
      childCharge: 0,
      childRefund: 0,
      total: -100,
      pending: 0,
    },
    {
      name: 'zero net bill',
      paid: false,
      refund: 500,
      childCharge: 0,
      childRefund: 0,
      total: 0,
      pending: 0,
    },
  ])('reports the actual payable amount for $name', async (scenario) => {
    await withRollback(async (db) => {
      const { accountService, ccFlow, billService, userId, expenseId } = await seed(db);
      const { account: parent } = await ccFlow.createCreditCard(userId, {
        name: 'Principal',
        closingDay: 3,
        dueDay: 10,
      });
      const child = await accountService.create(userId, {
        name: 'Additional',
        type: 'credit_card',
        currency: 'BRL',
        parentAccountId: parent.id,
      });
      const wallet = await accountService.create(userId, {
        name: 'Wallet',
        type: 'checking',
        currency: 'BRL',
      });
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const rows: Array<typeof transactions.$inferInsert> = [
        {
          ...tx(userId, expenseId, parent.id, '500.00', 'credit_card_expense'),
          isPaid: scenario.paid,
        },
      ];
      for (const [id, amount, domainType] of [
        [parent.id, scenario.refund, 'credit_card_refund'],
        [child.id, scenario.childCharge, 'credit_card_expense'],
        [child.id, scenario.childRefund, 'credit_card_refund'],
      ] as const) {
        if (amount > 0) rows.push(tx(userId, expenseId, id, String(amount), domainType));
      }
      await db
        .insert(transactions)
        .values(rows.map((row) => ({ ...row, date: now, billingMonth: month, billingYear: year })));

      const bill = await billService.getConsolidatedBill(userId, parent.id, month, year);
      expect(bill).toMatchObject({ total: scenario.total, unpaidTotal: scenario.pending });
      const summary = await billService.getBillSummary(userId);
      expect(summary.find((card) => card.cardId === parent.id)?.currentBill).toMatchObject({
        total: scenario.total,
        unpaidTotal: scenario.pending,
        month,
        year,
      });
      if (scenario.pending > 0) {
        const payment = await billService.payBill(userId, parent.id, month, year, wallet.id);
        expect(payment.billTotal).toBe(`${scenario.pending}.00`);
        expect(await billService.getConsolidatedBill(userId, parent.id, month, year)).toMatchObject(
          { unpaidTotal: 0 },
        );
      } else {
        await expect(
          billService.payBill(userId, parent.id, month, year, wallet.id),
        ).rejects.toThrow('Não há valor pendente');
      }
    });
  });

  it('keeps inactive children in history without including them in the payable amount', async () => {
    await withRollback(async (db) => {
      const { accountService, ccFlow, billService, userId, expenseId } = await seed(db);
      const { account: parent } = await ccFlow.createCreditCard(userId, {
        name: 'Principal',
        closingDay: 3,
        dueDay: 10,
      });
      const child = await accountService.create(userId, {
        name: 'Archived additional',
        type: 'credit_card',
        currency: 'BRL',
        parentAccountId: parent.id,
      });
      await db
        .insert(transactions)
        .values([
          tx(userId, expenseId, parent.id, '500.00', 'credit_card_expense'),
          tx(userId, expenseId, child.id, '300.00', 'credit_card_expense'),
        ]);
      await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, child.id));
      const bill = await billService.getConsolidatedBill(userId, parent.id, 6, 2026);
      expect(bill).toMatchObject({ total: 800, unpaidTotal: 500 });
      expect(bill.breakdown.find((entry) => entry.cardId === child.id)).toMatchObject({
        total: 300,
        unpaidTotal: 0,
      });
    });
  });

  it('sums parent + child nets and returns the principal first', async () => {
    await withRollback(async (db) => {
      const { accountService, ccFlow, billService, userId, expenseId } = await seed(db);
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
        color: '#00aa00',
      });

      await db
        .insert(transactions)
        .values([
          tx(userId, expenseId, parent.id, '1000.00', 'credit_card_expense'),
          tx(userId, expenseId, child.id, '500.00', 'credit_card_expense'),
        ]);

      const result = await billService.getConsolidatedBill(userId, parent.id, 6, 2026);

      expect(result.total).toBe(1500);
      expect(result.unpaidTotal).toBe(1500);
      expect(result.breakdown).toHaveLength(2);
      expect(result.breakdown[0]).toMatchObject({
        cardId: parent.id,
        isPrincipal: true,
        total: 1000,
      });
      expect(result.breakdown[1]).toMatchObject({
        cardId: child.id,
        isPrincipal: false,
        total: 500,
        color: '#00aa00',
      });
    });
  });

  it('reports consolidated isPaid + transactionCount across parent and children', async () => {
    await withRollback(async (db) => {
      const { accountService, ccFlow, billService, userId, expenseId } = await seed(db);
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

      await db
        .insert(transactions)
        .values([
          tx(userId, expenseId, parent.id, '1000.00', 'credit_card_expense'),
          tx(userId, expenseId, child.id, '500.00', 'credit_card_expense'),
        ]);

      const result = await billService.getConsolidatedBill(userId, parent.id, 6, 2026);
      // Any unpaid charge across parent + children keeps the consolidated unpaid.
      expect(result.isPaid).toBe(false);
      expect(result.transactionCount).toBe(2);
    });
  });

  it('subtracts refunds in each card net', async () => {
    await withRollback(async (db) => {
      const { accountService, ccFlow, billService, userId, expenseId } = await seed(db);
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

      await db
        .insert(transactions)
        .values([
          tx(userId, expenseId, parent.id, '1000.00', 'credit_card_expense'),
          tx(userId, expenseId, child.id, '500.00', 'credit_card_expense'),
          tx(userId, expenseId, child.id, '100.00', 'credit_card_refund'),
        ]);

      const result = await billService.getConsolidatedBill(userId, parent.id, 6, 2026);
      expect(result.total).toBe(1400);
      expect(result.breakdown.find((b) => b.cardId === child.id)?.total).toBe(400);
    });
  });

  it('returns only the principal when the card has no additionals', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, expenseId } = await seed(db);
      const { account: parent } = await ccFlow.createCreditCard(userId, {
        name: 'Solo',
        closingDay: 3,
        dueDay: 10,
      });

      await db
        .insert(transactions)
        .values([tx(userId, expenseId, parent.id, '750.00', 'credit_card_expense')]);

      const result = await billService.getConsolidatedBill(userId, parent.id, 6, 2026);

      expect(result.total).toBe(750);
      expect(result.breakdown).toHaveLength(1);
      expect(result.breakdown[0]).toMatchObject({
        cardId: parent.id,
        isPrincipal: true,
        total: 750,
      });
    });
  });

  it('never leaks another user data and rejects cross-user access', async () => {
    await withRollback(async (db) => {
      const {
        accountService,
        ccFlow,
        billService,
        userId: userIdA,
        expenseId: expenseIdA,
      } = await seed(db);
      const { account: parentA } = await ccFlow.createCreditCard(userIdA, {
        name: 'C6',
        closingDay: 3,
        dueDay: 10,
      });
      const childA = await accountService.create(userIdA, {
        name: 'C6 - Camila',
        type: 'credit_card',
        currency: 'BRL',
        parentAccountId: parentA.id,
      });

      await db
        .insert(transactions)
        .values([
          tx(userIdA, expenseIdA, parentA.id, '1000.00', 'credit_card_expense'),
          tx(userIdA, expenseIdA, childA.id, '500.00', 'credit_card_expense'),
        ]);

      // Second user with their own expense account, credit card, and transaction.
      const [userB] = await db
        .insert(userProfiles)
        .values({ email: 'consolidated-other@test.com', name: 'Other', passwordHash: 'hash' })
        .returning();
      const userIdB = userB.id;
      const expenseB = await accountService.create(userIdB, {
        name: 'Food B',
        type: 'expense',
        currency: 'BRL',
      });
      const { account: cardB } = await ccFlow.createCreditCard(userIdB, {
        name: 'C6 B',
        closingDay: 3,
        dueDay: 10,
      });
      await db
        .insert(transactions)
        .values([tx(userIdB, expenseB.id, cardB.id, '9999.00', 'credit_card_expense')]);

      const result = await billService.getConsolidatedBill(userIdA, parentA.id, 6, 2026);

      expect(result.total).toBe(1500);
      const cardIds = result.breakdown.map((b) => b.cardId).sort();
      expect(cardIds).toEqual([parentA.id, childA.id].sort());
      expect(result.breakdown.some((b) => b.cardId === cardB.id)).toBe(false);

      // User B cannot read user A's consolidated bill (ownership check).
      await expect(billService.getConsolidatedBill(userIdB, parentA.id, 6, 2026)).rejects.toThrow();
    });
  });
});
