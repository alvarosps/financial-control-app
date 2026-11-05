import type { DbExecutor } from '@fc/db';
import { transactions } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { AccountService } from '../services/account.service.ts';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);

async function seed(db: DbExecutor) {
  const user = await createTestUser(db);
  const accountService = new AccountService(db);
  const expense = await accountService.create(user.id, {
    name: 'Expenses',
    type: 'expense',
    currency: 'BRL',
  });
  const root = await accountService.create(user.id, {
    name: 'Root Card',
    type: 'credit_card',
    currency: 'BRL',
  });
  const child = await accountService.create(user.id, {
    name: 'Child Card',
    type: 'credit_card',
    currency: 'BRL',
    parentAccountId: root.id,
  });
  const caller = createCaller({
    db,
    userId: user.id,
    profileCache: createRequestProfileCache(db),
  });
  return { user, expense, root, child, caller };
}

describe('creditCard lifecycle router', () => {
  it('accepts calendar purchase/posting dates through the authenticated expense endpoint', async () => {
    await withRollback(async (db) => {
      const { expense, root, caller } = await seed(db);
      const input = {
        creditCardAccountId: root.id,
        expenseAccountId: expense.id,
        description: 'Compra',
        amount: '10.00',
        billingMonth: 8,
        billingYear: 2026,
      };
      const result = await caller.creditCard.addOneTimeExpense({
        ...input,
        purchaseDate: '2026-08-12',
        postedDate: '2026-08-13',
      });
      expect(result.transaction).toMatchObject({
        purchaseDate: '2026-08-12',
        postedDate: '2026-08-13',
        purchaseDateSource: 'user',
      });
      await expect(
        caller.creditCard.addOneTimeExpense({ ...input, purchaseDate: '2026-02-30' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('creates refunds through the protected card flow', async () => {
    await withRollback(async (db) => {
      const { expense, child, caller } = await seed(db);
      const result = await caller.creditCard.addRefund({
        creditCardAccountId: child.id,
        expenseAccountId: expense.id,
        description: 'Adiantamento',
        amount: '1000.00',
        billingMonth: 8,
        billingYear: 2026,
        refundDate: new Date('2026-08-31T12:00:00.000Z'),
      });

      expect(result.transaction).toMatchObject({
        sourceAccountId: expense.id,
        destinationAccountId: child.id,
        amount: '1000.00',
        domainType: 'credit_card_refund',
        billingMonth: 8,
        billingYear: 2026,
      });
    });
  });

  it('archives and reactivates a group through protected procedures', async () => {
    await withRollback(async (db) => {
      const { root, child, caller } = await seed(db);

      const archived = await caller.creditCard.archiveGroup({ cardAccountId: child.id });
      expect(archived).toEqual({
        rootId: root.id,
        memberIds: expect.arrayContaining([root.id, child.id]),
      });

      const listed = await caller.creditCard.listArchivedGroups();
      expect(listed).toEqual([
        expect.objectContaining({
          root: expect.objectContaining({ id: root.id }),
        }),
      ]);

      const reactivated = await caller.creditCard.reactivateGroup({ cardAccountId: root.id });
      expect(reactivated.memberIds).toEqual(expect.arrayContaining([root.id, child.id]));
      await expect(caller.creditCard.listArchivedGroups()).resolves.toEqual([]);
    });
  });

  it('rejects an ineligible group with conflict', async () => {
    await withRollback(async (db) => {
      const { user, expense, root, caller } = await seed(db);
      const now = new Date();
      await db.insert(transactions).values({
        userId: user.id,
        sourceAccountId: expense.id,
        destinationAccountId: root.id,
        amount: '10.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Current bill',
        date: now,
        billingMonth: now.getMonth() + 1,
        billingYear: now.getFullYear(),
        domainType: 'credit_card_expense',
        isPaid: false,
      });

      await expect(
        caller.creditCard.archiveGroup({ cardAccountId: root.id }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'CURRENT_BILL',
      });
    });
  });

  it('requires authentication', async () => {
    await withRollback(async (db) => {
      const anonymous = createCaller({
        db,
        userId: null,
        profileCache: createRequestProfileCache(db),
      });
      await expect(anonymous.creditCard.listArchivedGroups()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
