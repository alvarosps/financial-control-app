import { randomUUID } from 'node:crypto';
import {
  externalAccounts,
  externalConnections,
  externalMovements,
  integrationJobs,
  purchaseObservations,
  transactions,
} from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { purchaseFixture } from '../../test/purchase-fixture.ts';
import { withRollback } from '../../test/with-rollback.ts';
import { claimIntegrationJob, IntegrationJobService } from './integration-job.service.ts';
import { PluggyClient } from './pluggy-client.ts';
import { PluggyConnectionService } from './pluggy-connection.service.ts';
import { PluggySyncService } from './pluggy-sync.service.ts';

describe('PluggySyncService', () => {
  it.each([
    'BANK',
    'CREDIT',
  ])('persists %s pages and checkpoints atomically, resumes an empty page, and does not create ledger rows', async (kind) => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const itemId = randomUUID();
      const accountId = randomUUID();
      const transactionId = randomUUID();
      const data = {
        id: transactionId,
        accountId,
        description: 'Fixture',
        amount: -10,
        currencyCode: 'BRL',
        type: 'DEBIT',
        status: 'POSTED',
        date: '2026-09-28',
        createdAt: '2026-09-28T10:00:00Z',
        updatedAt: '2026-09-28T10:00:00Z',
      };
      let failPage = false;
      let overflowId: string | null = null;
      const client = new PluggyClient({
        clientId: 'fixture',
        clientSecret: 'fixture',
        delay: async () => {},
        fetcher: async (input) => {
          const url = new URL(input);
          if (url.pathname === '/auth') return Response.json({ apiKey: 'fixture' });
          if (url.pathname.startsWith('/items/'))
            return Response.json({
              id: itemId,
              status: 'UPDATED',
              connector: { id: 200, name: 'MeuPluggy' },
              lastUpdatedAt: '2026-09-28T12:00:00Z',
            });
          if (url.pathname === '/accounts')
            return Response.json({
              page: 1,
              totalPages: 1,
              total: 1,
              results: [
                {
                  id: accountId,
                  itemId,
                  name: 'Fixture',
                  type: kind,
                  currencyCode: 'BRL',
                  balance: -100,
                },
              ],
            });
          if (url.pathname.endsWith('/bills'))
            return Response.json({ page: 1, totalPages: 0, total: 0, results: [] });
          if (failPage) return Response.json({}, { status: 503 });
          if (url.searchParams.has('after'))
            return Response.json({
              results: overflowId ? [data, { ...data, id: overflowId }] : [data],
              next: null,
            });
          url.searchParams.set('after', 'opaque');
          return Response.json({ results: [], next: url.toString() });
        },
      });
      const connection = await new PluggyConnectionService(db, client, [
        { userId: f.user.id, itemId },
      ]).attach(f.user.id, itemId);
      const claim = () =>
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE integration_scheduler`);
          const lease = await claimIntegrationJob(tx);
          await tx.execute(sql`RESET ROLE`);
          if (!lease) throw new Error('Expected job');
          return lease;
        });
      const step = async () => {
        const lease = await claim();
        return db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE app_user`);
          const result = await new PluggySyncService(tx, client).step(lease);
          await tx.execute(sql`RESET ROLE`);
          return result;
        });
      };
      await step(); // source metadata
      await step(); // accounts
      if (kind === 'CREDIT') await step(); // bills
      const before = (await db.select().from(integrationJobs))[0].checkpoint;
      failPage = true;
      await step();
      expect((await db.select().from(integrationJobs))[0]).toMatchObject({
        checkpoint: before,
        status: 'pending',
        errorCode: 'PLUGGY_UNAVAILABLE',
      });
      expect((await db.select().from(externalConnections))[0].lastFetchedAt).toBeNull();
      await db.update(integrationJobs).set({ nextAttemptAt: new Date(0) });
      failPage = false;
      await step(); // empty page with next
      expect(await db.select().from(externalMovements)).toHaveLength(0);
      expect((await db.select().from(integrationJobs))[0].checkpoint).toMatchObject({
        cursor: expect.stringContaining('opaque'),
      });
      const savedCheckpoint = (await db.select().from(integrationJobs))[0].checkpoint;
      overflowId = randomUUID();
      const [externalAccount] = await db.select().from(externalAccounts);
      await db.insert(externalMovements).values({
        userId: f.user.id,
        externalAccountId: externalAccount.id,
        externalId: overflowId,
        payload: {},
        contentHash: 'a'.repeat(64),
        version: 2147483647,
        sourceUpdatedAt: new Date(0),
      });
      expect(await step()).toEqual({ status: 'retry' });
      expect(
        await db
          .select()
          .from(externalMovements)
          .where(eq(externalMovements.externalId, transactionId)),
      ).toHaveLength(0);
      expect((await db.select().from(integrationJobs))[0].checkpoint).toEqual(savedCheckpoint);
      await db.delete(externalMovements).where(eq(externalMovements.externalId, overflowId));
      overflowId = null;
      await db.update(integrationJobs).set({ nextAttemptAt: new Date(0) });
      await step(); // Persisted date page; also exhaust the creation-watermark sweep.
      for (let i = 0; i < 10; i++) {
        if ((await db.select().from(integrationJobs))[0].status === 'completed') break;
        await step();
      }
      expect((await db.select().from(integrationJobs))[0].status).toBe('completed');
      expect(await db.select().from(externalMovements)).toHaveLength(1);
      expect((await db.select().from(externalConnections))[0].lastFetchedAt).toBeInstanceOf(Date);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(0);
      await new IntegrationJobService(db).enqueue(f.user.id, connection.id, 'replay');
      for (let i = 0; i < 12; i++) {
        if ((await step()).status === 'completed') break;
      }
      expect((await db.select().from(externalMovements))[0].version).toBe(1);
      expect(
        await db
          .select()
          .from(purchaseObservations)
          .where(eq(purchaseObservations.userId, f.user.id)),
      ).toHaveLength(kind === 'CREDIT' ? 1 : 0);
      await expect(
        new PluggySyncService(db, client).step({
          jobId: randomUUID(),
          token: randomUUID(),
          userId: f.user.id,
        }),
      ).rejects.toThrow('INTEGRATION_RUNTIME_ROLE_REQUIRED');
    });
  });
});
