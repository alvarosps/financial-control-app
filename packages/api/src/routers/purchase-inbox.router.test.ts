import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);

describe('purchaseInbox router', () => {
  it('requires authentication and rejects external-source claims from the browser', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const anonymous = createCaller({
        db,
        userId: null,
        profileCache: createRequestProfileCache(db),
      });
      await expect(anonymous.purchaseInbox.list({})).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      await expect(anonymous.purchaseInbox.coverage({})).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      await expect(anonymous.purchaseInbox.metrics()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      await expect(
        anonymous.purchaseInbox.separateEvidence({
          observationId: f.card.id,
          eventId: f.card.id,
          version: 1,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      const caller = createCaller({
        db,
        userId: f.user.id,
        profileCache: createRequestProfileCache(db),
      });
      await expect(
        caller.purchaseInbox.capture({ ...f.event, source: 'pluggy' as 'manual' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      const captured = await caller.purchaseInbox.capture(f.event);
      expect((await caller.purchaseInbox.list({})).items.map((item) => item.id)).toEqual([
        captured.observation.id,
      ]);
    });
  });
  it('denies another owner reads and versioned decisions and rejects stale review', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const other = await purchaseFixture(db);
      const own = createCaller({
        db,
        userId: f.user.id,
        profileCache: createRequestProfileCache(db),
      });
      const stranger = createCaller({
        db,
        userId: other.user.id,
        profileCache: createRequestProfileCache(db),
      });
      const { observation } = await own.purchaseInbox.capture(f.event);
      await expect(
        stranger.purchaseInbox.coverage({ cardAccountId: f.card.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(stranger.purchaseInbox.detail({ id: observation.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        stranger.purchaseInbox.ignore({ observationId: observation.id, version: 1 }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const ignored = await own.purchaseInbox.ignore({ observationId: observation.id, version: 1 });
      await expect(
        own.purchaseInbox.reprocess({ observationId: observation.id, version: 1 }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(
        (
          await own.purchaseInbox.reprocess({
            observationId: observation.id,
            version: ignored.version,
          })
        ).review,
      ).toBe('needs_review');
    });
  });
});
