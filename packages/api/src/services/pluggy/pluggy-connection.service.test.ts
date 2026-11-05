import { randomUUID } from 'node:crypto';
import { externalAccounts, externalConnections, integrationJobs } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { getTestDb } from '../../test/pool.ts';
import { purchaseFixture } from '../../test/purchase-fixture.ts';
import { withRollback } from '../../test/with-rollback.ts';
import { PluggyClient, type PluggyFetch } from './pluggy-client.ts';
import { PluggyConnectionService } from './pluggy-connection.service.ts';

describe('PluggyConnectionService', () => {
  it('requires a server grant and connector 200, associates only owned accounts, and preserves paused history', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const other = await purchaseFixture(db);
      const itemId = randomUUID();
      const fetcher = vi.fn<PluggyFetch>(async (url) =>
        Response.json(
          new URL(url).pathname === '/auth'
            ? { apiKey: 'fixture' }
            : { id: itemId, status: 'UPDATED', connector: { id: 200, name: 'MeuPluggy' } },
        ),
      );
      const client = new PluggyClient({ clientId: 'fixture', clientSecret: 'fixture', fetcher });
      const service = new PluggyConnectionService(db, client, [{ userId: f.user.id, itemId }]);
      await expect(service.attach(other.user.id, itemId)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(fetcher).not.toHaveBeenCalled();
      const connection = await service.attach(f.user.id, itemId);
      expect((await service.attach(f.user.id, itemId)).id).toBe(connection.id);
      expect(await db.select().from(integrationJobs)).toHaveLength(1);
      const [external] = await db
        .insert(externalAccounts)
        .values({
          userId: f.user.id,
          connectionId: connection.id,
          externalId: randomUUID(),
          kind: 'CREDIT',
          currency: 'BRL',
          name: 'Fixture',
        })
        .returning();
      await expect(service.mapAccount(f.user.id, external.id, other.card.id)).rejects.toMatchObject(
        { code: 'NOT_FOUND' },
      );
      await service.mapAccount(f.user.id, external.id, f.card.id);
      const [concurrent] = await getTestDb().execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${f.user.id}::text,0)) AS acquired`,
      );
      expect(concurrent.acquired).toBe(false);
      await service.setPaused(f.user.id, connection.id, true);
      expect(
        (
          await db
            .select()
            .from(externalConnections)
            .where(eq(externalConnections.id, connection.id))
        )[0]?.status,
      ).toBe('paused');
      expect((await db.select().from(externalAccounts))[0]?.accountId).toBe(f.card.id);
      await expect(service.requestSync(f.user.id, connection.id)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });
  });
  it('rejects non-personal connectors even when an Item is configured', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const itemId = randomUUID();
      const client = new PluggyClient({
        clientId: 'fixture',
        clientSecret: 'fixture',
        fetcher: async (url) =>
          Response.json(
            new URL(url).pathname === '/auth'
              ? { apiKey: 'fixture' }
              : { id: itemId, status: 'UPDATED', connector: { id: 201, name: 'Other' } },
          ),
      });
      const service = new PluggyConnectionService(db, client, [{ userId: f.user.id, itemId }]);
      await expect(service.attach(f.user.id, itemId)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect(await db.select().from(externalConnections)).toHaveLength(0);
    });
  });
});
