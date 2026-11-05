import { userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';

import { withRollback } from '../test/with-rollback.ts';
import { MaterializationCoordinator } from './materialization-coordinator.service.ts';

describe('MaterializationCoordinator', () => {
  it('initializes materialization state when no checkpoint status exists', async () => {
    await withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'coordinator@example.com', name: 'Coordinator', passwordHash: 'hash' })
        .returning();
      await db.transaction(async (tx) => {
        const coordinator = new MaterializationCoordinator(tx);
        const checkpoint = await coordinator.captureCheckpoint(user.id);
        await expect(
          coordinator.finalizeScheduleChanges({
            checkpoint,
            fillScheduleIds: [],
            rebuildScheduleIds: [],
            minimumHorizonMonths: 12,
          }),
        ).resolves.toMatchObject({ created: 0, skipped: 0, scope: 'full' });
      });
    });
  });
});
