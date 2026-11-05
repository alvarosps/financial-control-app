import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

describe('budget router', () => {
  it('requires authentication and restricts the persisted limits to the current owner', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db),
        other = await purchaseFixture(db);
      const caller = (userId: string | null) =>
        createCallerFactory(appRouter)({ db, userId, profileCache: createRequestProfileCache(db) });
      await expect(caller(null).budget.list({ month: 9, year: 2026 })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      await caller(f.user.id).budget.create({ month: 9, year: 2026, limitAmount: '123.45' });
      expect((await caller(other.user.id).budget.list({ month: 9, year: 2026 })).items).toEqual([]);
      expect(
        (await caller(f.user.id).budget.list({ month: 9, year: 2026 })).items[0].limitAmount,
      ).toBe('123.45');
    }));
});
