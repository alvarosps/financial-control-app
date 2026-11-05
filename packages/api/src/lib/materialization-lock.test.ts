import { userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { runWithMaterializationLock } from './materialization-lock.ts';

describe('runWithMaterializationLock', () => {
  it('reuses an existing transaction and supports re-entry for the same user', async () => {
    await withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'materialization-lock@example.com', name: 'Lock', passwordHash: 'hash' })
        .returning();

      await db.transaction(async (tx) => {
        await runWithMaterializationLock(tx, user.id, async ({ db: firstTx, lock }) => {
          expect(lock.userId).toBe(user.id);
          await runWithMaterializationLock(firstTx, user.id, async ({ db: secondTx }) => {
            const rows = await secondTx
              .select({ id: userProfiles.id })
              .from(userProfiles)
              .where(eq(userProfiles.id, user.id));
            expect(rows).toEqual([{ id: user.id }]);
          });
        });
      });
    });
  });
});
