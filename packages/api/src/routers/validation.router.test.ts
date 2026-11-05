import type { DbExecutor } from '@fc/db';
import { userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);

async function seedCaller(db: DbExecutor) {
  const [u] = await db
    .insert(userProfiles)
    .values({
      email: `validation-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Test User',
      passwordHash: 'hashed',
    })
    .returning();
  return createCaller({ db, userId: u.id, profileCache: createRequestProfileCache(db) });
}

describe('router input validation (BAD_REQUEST, never 500)', () => {
  it('transaction.create rejects an amount above the money cap', async () => {
    await withRollback(async (db) => {
      const caller = await seedCaller(db);
      await expect(
        caller.transaction.create({
          sourceAccountId: crypto.randomUUID(),
          destinationAccountId: crypto.randomUUID(),
          amount: '999999999999.00',
          description: 'gigante',
          date: new Date('2026-06-10'),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('transaction.create rejects notes longer than 1000 chars', async () => {
    await withRollback(async (db) => {
      const caller = await seedCaller(db);
      await expect(
        caller.transaction.create({
          sourceAccountId: crypto.randomUUID(),
          destinationAccountId: crypto.randomUUID(),
          amount: '10.00',
          description: 'ok',
          date: new Date('2026-06-10'),
          notes: 'x'.repeat(1001),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('creditCard.addOneTimeExpense rejects an amount above the money cap', async () => {
    await withRollback(async (db) => {
      const caller = await seedCaller(db);
      await expect(
        caller.creditCard.addOneTimeExpense({
          creditCardAccountId: crypto.randomUUID(),
          expenseAccountId: crypto.randomUUID(),
          description: 'compra',
          amount: '100000000.00',
          billingMonth: 6,
          billingYear: 2026,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('auditLog.list rejects entityType longer than the varchar(50) column', async () => {
    await withRollback(async (db) => {
      const caller = await seedCaller(db);
      await expect(
        caller.auditLog.list({ entityType: 'x'.repeat(51), page: 1, pageSize: 20 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('scheduled.create rejects an amount above the money cap', async () => {
    await withRollback(async (db) => {
      const caller = await seedCaller(db);
      await expect(
        caller.scheduled.create({
          sourceAccountId: crypto.randomUUID(),
          destinationAccountId: crypto.randomUUID(),
          amount: '100000000.00',
          description: 'agendamento',
          frequency: 'monthly',
          startDate: new Date('2026-06-01'),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('loan.update rejects monthlyPayment above the money cap before account lookup', async () => {
    await withRollback(async (db) => {
      const caller = await seedCaller(db);
      await expect(
        caller.loan.update({
          accountId: crypto.randomUUID(),
          monthlyPayment: '100000000.00',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('account.update rejects overdraftLimit above the money cap before account lookup', async () => {
    await withRollback(async (db) => {
      const caller = await seedCaller(db);
      await expect(
        caller.account.update({
          id: crypto.randomUUID(),
          overdraftLimit: '100000000.00',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
});
