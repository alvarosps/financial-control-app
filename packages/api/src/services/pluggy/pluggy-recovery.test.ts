import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '@fc/db';
import {
  createDb,
  externalAccounts,
  externalConnections,
  externalMovements,
  integrationJobs,
  userProfiles,
} from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../../test/pool.ts';
import { purchaseFixture } from '../../test/purchase-fixture.ts';
import { withRollback } from '../../test/with-rollback.ts';
import { DataCoverageService } from '../data-coverage.service.ts';
import { claimIntegrationJob, IntegrationJobService } from './integration-job.service.ts';
import { PluggyClient } from './pluggy-client.ts';
import { PluggySyncService } from './pluggy-sync.service.ts';

async function fixture(db: DbExecutor) {
  const f = await purchaseFixture(db);
  const [connection] = await db
    .insert(externalConnections)
    .values({
      userId: f.user.id,
      itemId: randomUUID(),
      name: 'Recovery',
      lastFetchedAt: new Date('2026-09-28T00:00:00Z'),
    })
    .returning();
  const [account] = await db
    .insert(externalAccounts)
    .values({
      userId: f.user.id,
      connectionId: connection.id,
      externalId: randomUUID(),
      kind: 'CREDIT',
      name: 'Card',
      currency: 'BRL',
      accountId: f.card.id,
    })
    .returning();
  const data = {
    id: randomUUID(),
    accountId: account.externalId,
    description: 'Older purchase',
    amount: -10,
    currencyCode: 'BRL',
    type: 'DEBIT',
    status: 'POSTED',
    date: '2026-09-01',
    createdAt: '2026-09-29T00:00:00Z',
    updatedAt: '2026-09-29T00:00:00Z',
  };
  return { ...f, connection, account, data };
}
function client(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    status?: string;
    executionStatus?: string;
    read?: (url: URL) => Promise<Response>;
  } = {},
) {
  return new PluggyClient({
    clientId: 'fixture',
    clientSecret: 'fixture',
    fetcher: async (input) => {
      const url = new URL(input);
      if (url.pathname === '/auth') return Response.json({ apiKey: 'fixture' });
      if (url.pathname.startsWith('/items/'))
        return Response.json({
          id: f.connection.itemId,
          connector: { id: 200, name: 'Personal' },
          status: options.status ?? 'UPDATED',
          executionStatus: options.executionStatus ?? 'SUCCESS',
        });
      if (url.pathname === '/accounts')
        return Response.json({
          page: 1,
          totalPages: 1,
          total: 1,
          results: [
            {
              id: f.account.externalId,
              itemId: f.connection.itemId,
              type: 'CREDIT',
              name: 'Fixture',
              balance: 0,
              currencyCode: 'BRL',
            },
          ],
        });
      if (url.pathname.endsWith('/bills'))
        return Response.json({ page: 1, totalPages: 0, total: 0, results: [] });
      return options.read ? options.read(url) : Response.json({ results: [], next: null });
    },
  });
}
async function step(db: DbExecutor, api: PluggyClient) {
  const lease = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE integration_scheduler`);
    const lease = await claimIntegrationJob(tx);
    await tx.execute(sql`RESET ROLE`);
    return lease;
  });
  if (!lease) throw new Error('Expected claim');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    const result = await new PluggySyncService(tx, api).step(lease);
    await tx.execute(sql`RESET ROLE`);
    return result;
  });
}

describe('Pluggy recovery regressions', () => {
  it.each([
    true,
    false,
  ])('discovers older posted dates by created watermark (webhook %s)', async (webhook) =>
    withRollback(async (db) => {
      const f = await fixture(db);
      const requests: URL[] = [];
      const api = client(f, {
        read: async (url) => {
          requests.push(url);
          const from = url.searchParams.get('createdAtFrom');
          return Response.json({
            results: from && from <= f.data.createdAt ? [f.data] : [],
            next: null,
          });
        },
      });
      await new IntegrationJobService(db).enqueue(
        f.user.id,
        f.connection.id,
        'created',
        webhook
          ? {
              event: 'transactions/created',
              accountId: f.account.externalId,
              transactionsCreatedAtFrom: '2026-09-29T00:00:00Z',
            }
          : {},
      );
      for (let i = 0; i < 10; i++) {
        if ((await step(db, api)).status === 'completed') break;
      }
      expect(
        await db.select().from(externalMovements).where(eq(externalMovements.userId, f.user.id)),
      ).toHaveLength(1);
      expect(
        requests.some(
          (r) => r.searchParams.has('createdAtFrom') && !r.searchParams.has('dateFrom'),
        ),
      ).toBe(true);
    }));
  it.each([
    'OUTDATED',
    'PARTIAL_SUCCESS',
  ])('keeps %s recoverable and preserves incomplete coverage', async (failure) =>
    withRollback(async (db) => {
      const f = await fixture(db);
      await new IntegrationJobService(db).enqueue(f.user.id, f.connection.id, 'source');
      expect(
        await step(
          db,
          client(f, {
            status: failure === 'OUTDATED' ? 'OUTDATED' : 'UPDATED',
            executionStatus: failure === 'OUTDATED' ? 'CONNECTION_ERROR' : 'PARTIAL_SUCCESS',
          }),
        ),
      ).toEqual({ status: 'retry' });
      const [connection] = await db
        .select()
        .from(externalConnections)
        .where(eq(externalConnections.id, f.connection.id));
      expect(connection).toMatchObject({
        status: 'active',
        lastFetchedAt: new Date('2026-09-28T00:00:00Z'),
        errorCode: failure === 'OUTDATED' ? 'PLUGGY_SOURCE_NOT_READY' : 'PLUGGY_SOURCE_PARTIAL',
      });
      const coverage = await new DataCoverageService(
        db,
        () => new Date('2026-09-29T00:00:00Z'),
        false,
        true,
      ).get(f.user.id, f.card.id);
      expect(coverage[0].sources.find((s) => s.source === 'pluggy')).toMatchObject({
        state: 'error',
        lastSuccessfulFetchAt: new Date('2026-09-28T00:00:00Z'),
      });
      await db
        .update(integrationJobs)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(integrationJobs.connectionId, f.connection.id));
      expect(await step(db, client(f))).toEqual({ status: 'progress' });
    }));
  it('fences a delayed absence behind a newer committed read and restores an unchanged tombstoned payload', async () => {
    const db = getTestDb();
    const f = await db.transaction(fixture);
    const target = new URL(process.env.TEST_DATABASE_URL ?? '');
    target.searchParams.set('options', '-c role=app_user');
    const app = createDb(target.toString());
    target.searchParams.set('options', '-c role=integration_scheduler');
    const scheduler = createDb(target.toString());
    const concurrentStep = async (api: PluggyClient) => {
      const lease = await claimIntegrationJob(scheduler);
      if (!lease) throw new Error('Expected claim');
      return new PluggySyncService(app, api).step(lease);
    };
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending: Promise<unknown> | undefined;
    try {
      const enqueue = async (key: string) => {
        const job = await new IntegrationJobService(db).enqueue(f.user.id, f.connection.id, key, {
          event: 'transactions/deleted',
          accountId: f.account.externalId,
          transactionIds: [f.data.id],
        });
        await db
          .update(integrationJobs)
          .set({
            checkpoint: {
              phase: 'transactions',
              accountIds: [f.account.id],
              filters: { ids: [f.data.id] },
            },
          })
          .where(eq(integrationJobs.id, job));
      };
      await enqueue('initial');
      const present = client(f, {
        read: async () => Response.json({ results: [f.data], next: null }),
      });
      await concurrentStep(present);
      await enqueue('delayed');
      pending = concurrentStep(
        client(f, {
          read: async () => {
            entered?.();
            await barrier;
            return Response.json({ results: [], next: null });
          },
        }),
      );
      await waiting;
      await enqueue('newer');
      await concurrentStep(present);
      release?.();
      await pending;
      expect(
        (
          await db.select().from(externalMovements).where(eq(externalMovements.userId, f.user.id))
        )[0].retractedAt,
      ).toBeNull();
      await db
        .update(integrationJobs)
        .set({ status: 'completed', lease: null, leaseExpiresAt: null })
        .where(eq(integrationJobs.connectionId, f.connection.id));
      await enqueue('absent');
      await concurrentStep(client(f));
      expect(
        (
          await db.select().from(externalMovements).where(eq(externalMovements.userId, f.user.id))
        )[0].retractedAt,
      ).not.toBeNull();
      await enqueue('restore');
      await concurrentStep(present);
      expect(
        (
          await db.select().from(externalMovements).where(eq(externalMovements.userId, f.user.id))
        )[0].retractedAt,
      ).toBeNull();
    } finally {
      release?.();
      await pending;
      await app.$client.end();
      await scheduler.$client.end();
      await db.delete(userProfiles).where(eq(userProfiles.id, f.user.id));
    }
  });
});
