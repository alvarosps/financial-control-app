import { randomUUID } from 'node:crypto';
import { externalAccounts, externalConnections, externalMovements, transactions } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { purchaseFixture } from '../../test/purchase-fixture.ts';
import { withRollback } from '../../test/with-rollback.ts';
import { claimIntegrationJob, IntegrationJobService } from './integration-job.service.ts';
import { PluggyClient } from './pluggy-client.ts';
import { PluggySyncService } from './pluggy-sync.service.ts';

describe('canonical Pluggy events', () => {
  it('recovers an old pending transaction by ID outside the overlap window when a webhook is lost', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const itemId = randomUUID();
      const [connection] = await db
        .insert(externalConnections)
        .values({
          userId: f.user.id,
          itemId,
          name: 'Fixture',
          lastFetchedAt: new Date('2026-09-28T10:00:00Z'),
        })
        .returning();
      const [account] = await db
        .insert(externalAccounts)
        .values({
          userId: f.user.id,
          connectionId: connection.id,
          externalId: randomUUID(),
          kind: 'BANK',
          name: 'Fixture',
          currency: 'BRL',
        })
        .returning();
      const data = {
        id: randomUUID(),
        accountId: account.externalId,
        description: 'Old pending fixture',
        amount: -10,
        currencyCode: 'BRL',
        type: 'DEBIT',
        status: 'PENDING',
        date: '2026-01-01',
        createdAt: '2026-01-01T10:00:00Z',
        updatedAt: '2026-01-01T10:00:00Z',
      };
      await db.insert(externalMovements).values({
        userId: f.user.id,
        externalAccountId: account.id,
        externalId: data.id,
        payload: data,
        contentHash: 'a'.repeat(64),
        sourceUpdatedAt: new Date(data.updatedAt),
      });
      await new IntegrationJobService(db).enqueue(f.user.id, connection.id, 'recovery-fixture');
      const client = new PluggyClient({
        clientId: 'fixture',
        clientSecret: 'fixture',
        fetcher: async (input) => {
          const url = new URL(input);
          if (url.pathname === '/auth') return Response.json({ apiKey: 'fixture' });
          if (url.pathname.startsWith('/items/'))
            return Response.json({
              id: itemId,
              status: 'UPDATED',
              connector: { id: 200, name: 'MeuPluggy' },
            });
          if (url.pathname === '/accounts')
            return Response.json({
              page: 1,
              totalPages: 1,
              total: 1,
              results: [
                {
                  id: account.externalId,
                  itemId,
                  name: 'Fixture',
                  type: 'BANK',
                  currencyCode: 'BRL',
                  balance: -10,
                },
              ],
            });
          if (url.searchParams.get('ids') === data.id)
            return Response.json({
              results: [{ ...data, status: 'POSTED', updatedAt: '2026-09-28T10:00:00Z' }],
              next: null,
            });
          return Response.json({ results: [], next: null });
        },
      });
      for (let i = 0; i < 5; i++) {
        const lease = await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE integration_scheduler`);
          const claim = await claimIntegrationJob(tx);
          await tx.execute(sql`RESET ROLE`);
          if (!claim) throw new Error('Pending recovery was skipped');
          return claim;
        });
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE app_user`);
          await new PluggySyncService(tx, client).step(lease);
          await tx.execute(sql`RESET ROLE`);
        });
      }
      expect((await db.select().from(externalMovements))[0].payload).toMatchObject({
        status: 'POSTED',
      });
    });
  });
  it('rechecks out-of-order deletion and stores a tombstone only when the canonical ID is absent', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const itemId = randomUUID();
      const [connection] = await db
        .insert(externalConnections)
        .values({ userId: f.user.id, itemId, name: 'Fixture' })
        .returning();
      const [account] = await db
        .insert(externalAccounts)
        .values({
          userId: f.user.id,
          connectionId: connection.id,
          externalId: randomUUID(),
          kind: 'BANK',
          name: 'Fixture',
          currency: 'BRL',
        })
        .returning();
      const data = {
        id: randomUUID(),
        accountId: account.externalId,
        description: 'Fixture',
        amount: -10,
        currencyCode: 'BRL',
        type: 'DEBIT',
        status: 'POSTED',
        date: '2026-09-01',
        createdAt: '2026-09-01T10:00:00Z',
        updatedAt: '2026-09-01T10:00:00Z',
      };
      await db.insert(externalMovements).values({
        userId: f.user.id,
        externalAccountId: account.id,
        externalId: data.id,
        payload: data,
        contentHash: 'a'.repeat(64),
        sourceUpdatedAt: new Date(0),
      });
      let absent = false;
      const queries: URL[] = [];
      const client = new PluggyClient({
        clientId: 'fixture',
        clientSecret: 'fixture',
        fetcher: async (input) => {
          const url = new URL(input);
          if (url.pathname === '/auth') return Response.json({ apiKey: 'fixture' });
          if (url.pathname.startsWith('/items/'))
            return Response.json({
              id: itemId,
              status: 'UPDATED',
              connector: { id: 200, name: 'MeuPluggy' },
            });
          if (url.pathname === '/accounts')
            return Response.json({
              page: 1,
              totalPages: 1,
              total: 1,
              results: [
                {
                  id: account.externalId,
                  itemId,
                  name: 'Fixture',
                  type: 'BANK',
                  currencyCode: 'BRL',
                  balance: -10,
                },
              ],
            });
          queries.push(url);
          return Response.json({ results: absent ? [] : [data], next: null });
        },
      });
      const run = async (key: string) => {
        await new IntegrationJobService(db).enqueue(f.user.id, connection.id, key, {
          event: 'transactions/deleted',
          accountId: account.externalId,
          transactionIds: [data.id],
        });
        for (let i = 0; i < 3; i++) {
          const lease = await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE integration_scheduler`);
            const claim = await claimIntegrationJob(tx);
            await tx.execute(sql`RESET ROLE`);
            if (!claim) throw new Error('Expected job');
            return claim;
          });
          await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE app_user`);
            await new PluggySyncService(tx, client).step(lease);
            await tx.execute(sql`RESET ROLE`);
          });
        }
      };
      await run('old-delete');
      expect((await db.select().from(externalMovements))[0].retractedAt).toBeNull();
      absent = true;
      await run('current-delete');
      expect((await db.select().from(externalMovements))[0].retractedAt).toBeInstanceOf(Date);
      expect(
        queries.every(
          (url) => url.searchParams.get('ids') === data.id && !url.searchParams.has('dateFrom'),
        ),
      ).toBe(true);
      expect((await db.select().from(externalConnections))[0].lastFetchedAt).toBeNull();
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(0);
    });
  });
});
