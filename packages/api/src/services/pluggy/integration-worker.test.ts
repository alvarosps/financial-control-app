import { randomUUID } from 'node:crypto';
import {
  createDb,
  externalConnections,
  integrationIngressBuckets,
  integrationJobs,
  userProfiles,
} from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../../test/pool.ts';
import { purchaseFixture } from '../../test/purchase-fixture.ts';
import { handleIntegrationCron } from './integration-worker.ts';
import { PluggyClient } from './pluggy-client.ts';

describe('bounded integration worker', () => {
  it('authenticates, stops at its deadline, and leaves durable pending work for another invocation', async () => {
    const db = getTestDb();
    const f = await db.transaction((tx) => purchaseFixture(tx));
    const target = new URL(process.env.TEST_DATABASE_URL ?? '');
    target.searchParams.set('options', '-c role=app_user');
    const app = createDb(target.toString());
    target.searchParams.set('options', '-c role=integration_scheduler');
    const scheduler = createDb(target.toString());
    const itemId = randomUUID();
    let now = 0;
    const client = new PluggyClient({
      clientId: 'fixture',
      clientSecret: 'fixture',
      fetcher: async (input) => {
        if (new URL(input).pathname === '/auth') return Response.json({ apiKey: 'fixture' });
        now = 50_000;
        return Response.json({
          id: itemId,
          status: 'UPDATED',
          connector: { id: 200, name: 'MeuPluggy' },
        });
      },
    });
    const secret = randomUUID();
    const request = (token: string) =>
      new Request('https://fixture.test/api/cron/integrations', {
        headers: { Authorization: `Bearer ${token}` },
      });
    try {
      await db.insert(externalConnections).values({ userId: f.user.id, itemId, name: 'Fixture' });
      const deps = { app, scheduler, client, now: () => now };
      expect((await handleIntegrationCron(request('invalid'), secret, deps)).status).toBe(401);
      const result = await handleIntegrationCron(request(secret), secret, deps);
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ processed: 1, stopped: 'deadline' });
      const jobs = await db
        .select()
        .from(integrationJobs)
        .where(eq(integrationJobs.userId, f.user.id));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        status: 'pending',
        checkpoint: { phase: 'accounts' },
        lease: null,
      });
    } finally {
      await app.$client.end();
      await scheduler.$client.end();
      await db.delete(userProfiles).where(eq(userProfiles.id, f.user.id));
      await db
        .delete(integrationIngressBuckets)
        .where(
          and(
            eq(integrationIngressBuckets.bucket, 'scheduler'),
            eq(integrationIngressBuckets.attempts, 1),
          ),
        );
    }
  });
});
