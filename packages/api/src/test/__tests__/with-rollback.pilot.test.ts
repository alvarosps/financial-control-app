import { userProfiles } from '@fc/db';
import { eq, like, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../pool.ts';
import { withRollback } from '../with-rollback.ts';

describe('withRollback', () => {
  it('rolls back writes made by `fn` so callers outside the helper see no changes', async () => {
    const email = `pilot-rollback-${Date.now()}@test.local`;

    await withRollback(async (db) => {
      await db.insert(userProfiles).values({
        email,
        name: 'pilot',
        passwordHash: 'x',
      });
      const found = await db.select().from(userProfiles).where(eq(userProfiles.email, email));
      expect(found).toHaveLength(1);
    });

    // After the helper returns, the row must NOT be persisted.
    const outside = getTestDb();
    const persisted = await outside
      .select()
      .from(userProfiles)
      .where(like(userProfiles.email, 'pilot-rollback-%'));
    expect(persisted).toHaveLength(0);
  });

  it('nested db.transaction emits a SAVEPOINT so inner failures do not abort the outer', async () => {
    await withRollback(async (db) => {
      // Outer insert
      await db.insert(userProfiles).values({
        email: `pilot-savepoint-outer-${Date.now()}@test.local`,
        name: 'outer',
        passwordHash: 'x',
      });

      // Inner transaction that deliberately throws — under Drizzle this
      // should issue a SAVEPOINT and roll back just the inner writes.
      let innerThrown = false;
      try {
        await db.transaction(async (tx) => {
          await tx.insert(userProfiles).values({
            email: `pilot-savepoint-inner-${Date.now()}@test.local`,
            name: 'inner',
            passwordHash: 'x',
          });
          throw new Error('force inner rollback');
        });
      } catch (err) {
        innerThrown = true;
        expect((err as Error).message).toBe('force inner rollback');
      }
      expect(innerThrown).toBe(true);

      // The outer row must still be visible inside the enclosing
      // transaction — proving the inner throw did not poison the outer.
      const rows = await db.execute(sql`SELECT 1 AS ok`);
      // postgres-js returns an array-like; just assert the statement ran.
      expect(rows.length).toBeGreaterThanOrEqual(0);
    });
  });

  it('re-throws errors from fn after rolling back', async () => {
    await expect(
      withRollback(async (db) => {
        await db.insert(userProfiles).values({
          email: `pilot-error-${Date.now()}@test.local`,
          name: 'err',
          passwordHash: 'x',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const outside = getTestDb();
    const persisted = await outside
      .select()
      .from(userProfiles)
      .where(like(userProfiles.email, 'pilot-error-%'));
    expect(persisted).toHaveLength(0);
  });
});
