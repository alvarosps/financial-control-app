import type { DbExecutor } from '@fc/db';
import { userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);

async function seedUser(db: DbExecutor) {
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `guard-${Date.now()}-${Math.random()}@test.com`,
      name: 'guard',
      passwordHash: 'hashed',
    })
    .returning();
  return user;
}

describe('protectedProcedure DB guard', () => {
  it('rejects requests whose userId points to a missing userProfile row', async () => {
    await withRollback(async (db) => {
      const caller = createCaller({
        db,
        userId: '00000000-0000-0000-0000-000000000000',
        profileCache: createRequestProfileCache(db),
      });

      await expect(caller.account.list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  it('rejects requests with no userId', async () => {
    await withRollback(async (db) => {
      const caller = createCaller({
        db,
        userId: null,
        profileCache: createRequestProfileCache(db),
      });

      await expect(caller.account.list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  it('allows requests whose profile exists and caches the lookup for the request', async () => {
    await withRollback(async (db) => {
      const user = await seedUser(db);
      const cache = createRequestProfileCache(db);
      const spy = vi.spyOn(cache, 'get');

      const caller = createCaller({ db, userId: user.id, profileCache: cache });

      await caller.account.list({});
      await caller.account.list({});
      await caller.category.list();

      expect(spy).toHaveBeenCalledTimes(3);
      const promises = new Set(spy.mock.results.map((r) => r.value));
      expect(promises.size).toBe(1);
    });
  });

  it('rejects after the profile is deleted even if the session was previously valid', async () => {
    await withRollback(async (db) => {
      const user = await seedUser(db);
      const freshCaller = () =>
        createCaller({ db, userId: user.id, profileCache: createRequestProfileCache(db) });

      await freshCaller().account.list({});

      await db.delete(userProfiles).where(eq(userProfiles.id, user.id));

      await expect(freshCaller().account.list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });
});
