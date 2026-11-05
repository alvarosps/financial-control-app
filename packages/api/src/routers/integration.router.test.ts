import { randomUUID } from 'node:crypto';
import { externalAccounts, externalConnections, externalMovements, integrationJobs } from '@fc/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('integration router', () => {
  it('requires authentication and ownership, exposes status without credentials and preserves paused history', async () => {
    await withRollback(async (db) => {
      vi.stubEnv('PLUGGY_ENABLED', 'false');
      vi.stubEnv('PLUGGY_CLIENT_SECRET', 'never-expose-this-secret');
      const f = await purchaseFixture(db),
        foreign = await purchaseFixture(db);
      const [connection] = await db
        .insert(externalConnections)
        .values({
          userId: f.user.id,
          itemId: randomUUID(),
          name: 'Fixture',
          sourceUpdatedAt: new Date('2026-09-25'),
        })
        .returning();
      const [external] = await db
        .insert(externalAccounts)
        .values({
          userId: f.user.id,
          connectionId: connection.id,
          externalId: randomUUID(),
          accountId: f.card.id,
          kind: 'CREDIT',
          name: 'Fixture card',
          currency: 'BRL',
        })
        .returning();
      const externalId = randomUUID();
      await db.insert(externalMovements).values({
        userId: f.user.id,
        externalAccountId: external.id,
        externalId,
        contentHash: 'a'.repeat(64),
        sourceUpdatedAt: new Date(),
        payload: {
          id: externalId,
          accountId: external.externalId,
          description: 'Unknown credit',
          amount: 10,
          currencyCode: 'BRL',
          date: '2026-09-25',
          type: 'CREDIT',
          status: 'POSTED',
          createdAt: '2026-09-25',
          updatedAt: '2026-09-25',
        },
      });
      await db.insert(integrationJobs).values({
        userId: f.user.id,
        connectionId: connection.id,
        idempotencyKey: 'fixture',
        lease: randomUUID(),
        leaseExpiresAt: new Date(),
        status: 'failed',
        errorCode: 'PLUGGY_UNAVAILABLE',
      });
      const caller = (userId: string | null) =>
        createCaller({ db, userId, profileCache: createRequestProfileCache(db) });
      await expect(caller(null).integration.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect((await caller(foreign.user.id).integration.list()).connections).toEqual([]);
      const result = await caller(f.user.id).integration.list();
      expect(result).toMatchObject({
        enabled: false,
        connections: [
          {
            id: connection.id,
            lastFetchedAt: null,
            accounts: [{ accountId: f.card.id }],
            jobs: [{ status: 'failed' }],
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('never-expose');
      expect(JSON.stringify(result)).not.toContain('lease');
      expect(
        (await caller(f.user.id).integration.cardExceptions({ externalAccountId: external.id }))
          .items,
      ).toMatchObject([{ reason: 'unknown_credit' }]);
      await expect(
        caller(foreign.user.id).integration.cardExceptions({ externalAccountId: external.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller(foreign.user.id).integration.pause({ connectionId: connection.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller(f.user.id).integration.sync({ connectionId: connection.id }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await caller(f.user.id).integration.pause({ connectionId: connection.id });
      expect((await caller(f.user.id).integration.list()).connections[0]).toMatchObject({
        status: 'paused',
        accounts: [{ accountId: f.card.id }],
      });
      vi.stubEnv('PLUGGY_PERSONAL_ITEMS', 'invalid-json');
      await caller(f.user.id).integration.pause({ connectionId: connection.id });
      expect((await caller(f.user.id).integration.list()).connections).toHaveLength(1);
    });
  });
  it('accepts only server-granted personal Items and enqueues explicit available-data fetches', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db),
        itemId = randomUUID();
      vi.stubEnv('PLUGGY_ENABLED', 'true');
      vi.stubEnv('PLUGGY_CLIENT_ID', 'fixture');
      vi.stubEnv('PLUGGY_CLIENT_SECRET', 'fixture');
      vi.stubEnv('PLUGGY_PERSONAL_ITEMS', JSON.stringify([{ userId: f.user.id, itemId }]));
      const paths: string[] = [];
      vi.stubGlobal('fetch', async (input: string) => {
        const path = new URL(input).pathname;
        paths.push(path);
        return path === '/auth'
          ? Response.json({ apiKey: 'fixture' })
          : Response.json({
              id: itemId,
              status: 'UPDATED',
              connector: { id: 200, name: 'MeuPluggy' },
            });
      });
      const caller = createCaller({
        db,
        userId: f.user.id,
        profileCache: createRequestProfileCache(db),
      });
      await expect(caller.integration.attach({ itemId: randomUUID() })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(paths).toEqual([]);
      const connection = await caller.integration.attach({ itemId });
      await caller.integration.sync({ connectionId: connection.id });
      const status = await caller.integration.list();
      expect(status.connections[0].jobs).toHaveLength(2);
      expect(paths).toEqual(['/auth', `/items/${itemId}`]);
    });
  });
});
