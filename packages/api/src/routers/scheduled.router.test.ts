import type { DbExecutor } from '@fc/db';
import { accounts, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);

async function seed(db: DbExecutor) {
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `scheduled-router-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Test User',
      passwordHash: 'hashed',
    })
    .returning();
  const [expense] = await db
    .insert(accounts)
    .values({ userId: user.id, name: 'Expenses', type: 'expense', currency: 'BRL' })
    .returning();
  const [card] = await db
    .insert(accounts)
    .values({ userId: user.id, name: 'Card', type: 'credit_card', currency: 'BRL' })
    .returning();

  return { userId: user.id, expense, card };
}

describe('scheduled.create startingOccurrence guard', () => {
  it('rejects startingOccurrence=2 with BAD_REQUEST', async () => {
    await withRollback(async (db) => {
      const { userId, expense, card } = await seed(db);
      const caller = createCaller({ db, userId, profileCache: createRequestProfileCache(db) });

      await expect(
        caller.scheduled.create({
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          amount: '100.00',
          description: 'Mid-stream installment',
          frequency: 'monthly',
          startDate: new Date('2026-07-10'),
          totalOccurrences: 10,
          startingOccurrence: 2,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('accepts startingOccurrence=1', async () => {
    await withRollback(async (db) => {
      const { userId, expense, card } = await seed(db);
      const caller = createCaller({ db, userId, profileCache: createRequestProfileCache(db) });

      const schedule = await caller.scheduled.create({
        sourceAccountId: expense.id,
        destinationAccountId: card.id,
        amount: '100.00',
        description: 'Normalized installment',
        frequency: 'monthly',
        startDate: new Date('2026-05-10'),
        totalOccurrences: 10,
        startingOccurrence: 1,
      });

      expect(schedule.startingOccurrence).toBe(1);
    });
  });
});
