import { randomUUID } from 'node:crypto';
import { externalAccounts, externalConnections, integrationJobs, userProfiles } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../../test/pool.ts';
import { purchaseFixture } from '../../test/purchase-fixture.ts';
import { withRollback } from '../../test/with-rollback.ts';

describe('integration job database boundary', () => {
  it('allows only one concurrent worker to claim a committed job', async () => {
    const db = getTestDb();
    const f = await db.transaction((tx) => purchaseFixture(tx));
    try {
      const [connection] = await db
        .insert(externalConnections)
        .values({ userId: f.user.id, itemId: randomUUID(), name: 'Concurrency fixture' })
        .returning();
      await db
        .insert(integrationJobs)
        .values({ userId: f.user.id, connectionId: connection.id, idempotencyKey: 'race' });
      const claim = () =>
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE integration_scheduler`);
          return tx.execute(sql`SELECT * FROM claim_integration_job()`);
        });
      const results = await Promise.all([claim(), claim()]);
      expect(results.flat()).toHaveLength(1);
    } finally {
      await db.delete(userProfiles).where(eq(userProfiles.id, f.user.id));
    }
  });
  it('limits global claims to the scheduler and prevents ordinary sessions from forging leases', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const [connection] = await db
        .insert(externalConnections)
        .values({ userId: f.user.id, itemId: randomUUID(), name: 'Fixture' })
        .returning();
      const [job] = await db
        .insert(integrationJobs)
        .values({ userId: f.user.id, connectionId: connection.id, idempotencyKey: 'fixture' })
        .returning();
      await db.execute(sql`SELECT set_config('app.current_user_id', ${f.user.id}, true)`);
      await db.execute(sql`SET LOCAL ROLE app_user`);
      expect(await db.select().from(integrationJobs)).toHaveLength(1);
      await expect(
        db.transaction((tx) => tx.execute(sql`SELECT * FROM claim_integration_job()`)),
      ).rejects.toThrow();
      await expect(
        db.transaction((tx) =>
          tx
            .update(integrationJobs)
            .set({ lease: randomUUID() })
            .where(eq(integrationJobs.id, job.id)),
        ),
      ).rejects.toThrow();
      const forged = await db.execute(
        sql`SELECT checkpoint_integration_job(${job.id}::uuid, ${randomUUID()}::uuid, '{}'::jsonb, false, NULL, 0) AS accepted`,
      );
      expect(forged[0]?.accepted).toBe(false);
      await db.execute(sql`SET LOCAL ROLE integration_scheduler`);
      await expect(
        db.transaction((tx) => tx.execute(sql`SELECT * FROM transactions`)),
      ).rejects.toThrow();
      const claim = await db.execute(sql`SELECT * FROM claim_integration_job()`);
      expect(claim).toHaveLength(1);
      expect(Object.keys(claim[0])).toEqual(['job_id', 'lease_token']);
      expect(await db.execute(sql`SELECT * FROM claim_integration_job()`)).toHaveLength(0);
      const owner = await db.execute(
        sql`SELECT * FROM resolve_integration_job(${job.id}::uuid, ${claim[0].lease_token}::uuid)`,
      );
      expect(owner[0]?.owner_id).toBe(f.user.id);
      await db.execute(sql`SET LOCAL ROLE app_user`);
      const done = await db.execute(
        sql`SELECT checkpoint_integration_job(${job.id}::uuid, ${claim[0].lease_token}::uuid, '{"page":2}'::jsonb, true, NULL, 0) AS accepted`,
      );
      expect(done[0]?.accepted).toBe(true);
      const [finished] = await db
        .select()
        .from(integrationJobs)
        .where(eq(integrationJobs.id, job.id));
      expect(finished).toMatchObject({ status: 'completed', checkpoint: { page: 2 }, lease: null });
    });
  });
  it('enforces owners in mappings and rows independently of application validation', async () => {
    await withRollback(async (db) => {
      const a = await purchaseFixture(db);
      const b = await purchaseFixture(db);
      const [connection] = await db
        .insert(externalConnections)
        .values({ userId: a.user.id, itemId: randomUUID(), name: 'Fixture' })
        .returning();
      await expect(
        db.transaction((tx) =>
          tx.insert(externalAccounts).values({
            userId: a.user.id,
            connectionId: connection.id,
            externalId: randomUUID(),
            kind: 'CREDIT',
            name: 'Fixture',
            currency: 'BRL',
            accountId: b.card.id,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        db.transaction((tx) =>
          tx
            .insert(integrationJobs)
            .values({ userId: b.user.id, connectionId: connection.id, idempotencyKey: 'invalid' }),
        ),
      ).rejects.toThrow();
      await db.execute(sql`SELECT set_config('app.current_user_id', ${b.user.id}, true)`);
      await db.execute(sql`SET LOCAL ROLE app_user`);
      expect(await db.select().from(externalConnections)).toHaveLength(0);
    });
  });
  it('reclaims expired work and rejects its old token without losing the checkpoint', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const [connection] = await db
        .insert(externalConnections)
        .values({ userId: f.user.id, itemId: randomUUID(), name: 'Fixture' })
        .returning();
      const old = randomUUID();
      const [job] = await db
        .insert(integrationJobs)
        .values({
          userId: f.user.id,
          connectionId: connection.id,
          idempotencyKey: 'resume',
          status: 'running',
          lease: old,
          leaseExpiresAt: new Date(0),
          checkpoint: { after: 'opaque' },
        })
        .returning();
      await db.execute(sql`SET LOCAL ROLE integration_scheduler`);
      const claim = await db.execute(sql`SELECT * FROM claim_integration_job()`);
      expect(claim[0]?.lease_token).not.toBe(old);
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', ${f.user.id}, true)`);
      const result = await db.execute(
        sql`SELECT checkpoint_integration_job(${job.id}::uuid, ${old}::uuid, '{}'::jsonb, true, NULL, 0) AS accepted`,
      );
      expect(result[0]?.accepted).toBe(false);
      expect((await db.select().from(integrationJobs))[0]?.checkpoint).toEqual({ after: 'opaque' });
    });
  });
});
