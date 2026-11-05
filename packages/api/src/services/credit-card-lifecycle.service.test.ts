import type { DbExecutor } from '@fc/db';
import { accounts, scheduledTransactions, transactions } from '@fc/db';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { CreditCardLifecycleService } from './credit-card-lifecycle.service.ts';

const NOW = new Date(2026, 6, 25);

async function seedGroup(db: DbExecutor) {
  const user = await createTestUser(db);
  const accountService = new AccountService(db);
  const expense = await accountService.create(user.id, {
    name: 'Despesas',
    type: 'expense',
    currency: 'BRL',
  });
  const root = await accountService.create(user.id, {
    name: 'Principal',
    type: 'credit_card',
    currency: 'BRL',
    color: '#7c3aed',
  });
  const child = await accountService.create(user.id, {
    name: 'Adicional',
    type: 'credit_card',
    currency: 'BRL',
    parentAccountId: root.id,
  });
  return { user, expense, root, child };
}

async function addBillRow(
  db: DbExecutor,
  input: {
    userId: string;
    sourceAccountId: string;
    cardId: string;
    amount: string;
    month: number;
    year: number;
    domainType?: 'credit_card_expense' | 'credit_card_refund';
  },
) {
  await db.insert(transactions).values({
    userId: input.userId,
    sourceAccountId: input.sourceAccountId,
    destinationAccountId: input.cardId,
    amount: input.amount,
    currency: 'BRL',
    type: 'withdrawal',
    description: 'Teste',
    date: new Date(input.year, input.month - 1, 5),
    billingMonth: input.month,
    billingYear: input.year,
    domainType: input.domainType ?? 'credit_card_expense',
    isPaid: false,
  });
}

describe('CreditCardLifecycleService', () => {
  it('resolves the principal group from an additional card and allows a zero empty group', async () => {
    await withRollback(async (db) => {
      const { user, root, child } = await seedGroup(db);
      const lifecycle = new CreditCardLifecycleService(db, () => NOW);

      const group = await lifecycle.resolveGroup(user.id, child.id);
      expect(group.root.id).toBe(root.id);
      expect(group.members.map((member) => member.id).sort()).toEqual([root.id, child.id].sort());
      await expect(lifecycle.getArchiveEligibility(user.id, child.id)).resolves.toEqual({
        canArchive: true,
        blockedReason: null,
      });
    });
  });

  it('blocks positive and negative current consolidated bills', async () => {
    await withRollback(async (db) => {
      const { user, expense, root, child } = await seedGroup(db);
      const lifecycle = new CreditCardLifecycleService(db, () => NOW);

      await addBillRow(db, {
        userId: user.id,
        sourceAccountId: expense.id,
        cardId: child.id,
        amount: '100.00',
        month: 7,
        year: 2026,
      });
      await expect(lifecycle.getArchiveEligibility(user.id, root.id)).resolves.toEqual({
        canArchive: false,
        blockedReason: 'CURRENT_BILL',
      });

      await addBillRow(db, {
        userId: user.id,
        sourceAccountId: expense.id,
        cardId: root.id,
        amount: '150.00',
        month: 7,
        year: 2026,
        domainType: 'credit_card_refund',
      });
      await expect(lifecycle.getArchiveEligibility(user.id, root.id)).resolves.toEqual({
        canArchive: false,
        blockedReason: 'CURRENT_BILL',
      });
    });
  });

  it('blocks future materialized transactions and indefinite schedules', async () => {
    await withRollback(async (db) => {
      const { user, expense, root } = await seedGroup(db);
      const lifecycle = new CreditCardLifecycleService(db, () => NOW);

      await addBillRow(db, {
        userId: user.id,
        sourceAccountId: expense.id,
        cardId: root.id,
        amount: '25.00',
        month: 8,
        year: 2026,
      });
      await expect(lifecycle.getArchiveEligibility(user.id, root.id)).resolves.toEqual({
        canArchive: false,
        blockedReason: 'FUTURE_COMMITMENTS',
      });

      await db
        .delete(transactions)
        .where(
          and(eq(transactions.userId, user.id), eq(transactions.destinationAccountId, root.id)),
        );
      await db.insert(scheduledTransactions).values({
        userId: user.id,
        sourceAccountId: expense.id,
        destinationAccountId: root.id,
        amount: '25.00',
        currency: 'BRL',
        description: 'Assinatura',
        frequency: 'monthly',
        startDate: new Date(2026, 0, 1),
        dueDay: 10,
        domainType: 'credit_card_fixed_charge',
        isFixedCharge: true,
        isActive: true,
      });
      await expect(lifecycle.getArchiveEligibility(user.id, root.id)).resolves.toEqual({
        canArchive: false,
        blockedReason: 'FUTURE_COMMITMENTS',
      });
    });
  });

  it('archives and reactivates the whole group atomically from a child id', async () => {
    await withRollback(async (db) => {
      const { user, root, child } = await seedGroup(db);
      const lifecycle = new CreditCardLifecycleService(db, () => NOW);

      const archived = await lifecycle.archiveGroup(user.id, child.id);
      expect(archived.rootId).toBe(root.id);
      expect(archived.memberIds.sort()).toEqual([root.id, child.id].sort());

      const inactive = await db
        .select({ id: accounts.id, isActive: accounts.isActive })
        .from(accounts)
        .where(inArray(accounts.id, [root.id, child.id]));
      expect(inactive.every((account) => !account.isActive)).toBe(true);

      const listed = await lifecycle.listArchivedGroups(user.id);
      expect(listed).toEqual([
        expect.objectContaining({
          root: expect.objectContaining({ id: root.id, name: 'Principal' }),
          members: expect.arrayContaining([
            expect.objectContaining({ id: root.id }),
            expect.objectContaining({ id: child.id }),
          ]),
        }),
      ]);

      const reactivated = await lifecycle.reactivateGroup(user.id, root.id);
      expect(reactivated.memberIds.sort()).toEqual([root.id, child.id].sort());
      const active = await db
        .select({ id: accounts.id, isActive: accounts.isActive })
        .from(accounts)
        .where(inArray(accounts.id, [root.id, child.id]));
      expect(active.every((account) => account.isActive)).toBe(true);
    });
  });

  it('does not expose or mutate another user card', async () => {
    await withRollback(async (db) => {
      const owner = await seedGroup(db);
      const outsider = await createTestUser(db);
      const lifecycle = new CreditCardLifecycleService(db, () => NOW);

      await expect(lifecycle.resolveGroup(outsider.id, owner.root.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(lifecycle.archiveGroup(outsider.id, owner.root.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(lifecycle.listArchivedGroups(outsider.id)).resolves.toEqual([]);
    });
  });
});
