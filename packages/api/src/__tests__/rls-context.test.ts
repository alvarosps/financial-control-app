import type { DbExecutor } from '@fc/db';
import { categories, userProfiles } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory, protectedProcedure, router } from '../trpc.ts';

const probeRouter = router({
  guc: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.execute(
      sql`SELECT current_setting('app.current_user_id', true) AS uid`,
    );
    return rows[0]?.uid ?? null;
  }),
  failAfterWrite: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .insert(categories)
      .values({ userId: ctx.userId, name: 'rollback-probe', type: 'expense' });
    throw new Error('boom after write');
  }),
});

const createProbeCaller = createCallerFactory(probeRouter);

async function seedUser(db: DbExecutor) {
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `rls-ctx-${Date.now()}-${Math.random()}@test.com`,
      name: 'rls ctx',
      passwordHash: 'hashed',
    })
    .returning();
  return user;
}

describe('protectedProcedure request transaction + RLS GUC', () => {
  it('sets app.current_user_id for the duration of the procedure', async () => {
    await withRollback(async (db) => {
      const user = await seedUser(db);
      const caller = createProbeCaller({
        db,
        userId: user.id,
        profileCache: createRequestProfileCache(db),
      });

      const uid = await caller.guc();
      expect(uid).toBe(user.id);
    });
  });

  it('rolls back writes when the procedure throws (no partial commit)', async () => {
    await withRollback(async (db) => {
      const user = await seedUser(db);
      const caller = createProbeCaller({
        db,
        userId: user.id,
        profileCache: createRequestProfileCache(db),
      });

      await expect(caller.failAfterWrite()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });

      const leftover = await db.select().from(categories).where(eq(categories.userId, user.id));
      expect(leftover).toHaveLength(0);
    });
  });
});
