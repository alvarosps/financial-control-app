import type { DbExecutor } from '@fc/db';
import { externalConnections, integrationJobs } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';

export type IntegrationLease = { jobId: string; token: string; userId: string };
export async function assertIntegrationRole(
  db: DbExecutor,
  role: 'app_user' | 'integration_scheduler',
) {
  const rows = await db.execute(
    sql`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  if (rows[0]?.rolname !== role || rows[0]?.rolsuper !== false || rows[0]?.rolbypassrls !== false) {
    throw new Error('INTEGRATION_RUNTIME_ROLE_REQUIRED');
  }
}
export async function claimIntegrationJob(scheduler: DbExecutor): Promise<IntegrationLease | null> {
  await assertIntegrationRole(scheduler, 'integration_scheduler');
  return scheduler.transaction(async (tx) => {
    const rows = await tx.execute(sql`SELECT * FROM claim_integration_job()`);
    if (!rows.length) return null;
    const jobId = String(rows[0].job_id);
    const token = String(rows[0].lease_token);
    const owners = await tx.execute(
      sql`SELECT * FROM resolve_integration_job(${jobId}::uuid, ${token}::uuid)`,
    );
    if (typeof owners[0]?.owner_id !== 'string') throw new Error('INTEGRATION_LEASE_LOST');
    return { jobId, token, userId: owners[0].owner_id };
  });
}
export class IntegrationJobService {
  constructor(private db: DbExecutor) {}

  async enqueue(userId: string, connectionId: string, key: string, payload: unknown = {}) {
    if (!key || key.length > 200) throw new Error('INTEGRATION_KEY_INVALID');
    const [connection] = await this.db
      .select()
      .from(externalConnections)
      .where(and(eq(externalConnections.id, connectionId), eq(externalConnections.userId, userId)));
    if (!connection) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
    await this.db.execute(sql`INSERT INTO integration_jobs (user_id, connection_id, idempotency_key, payload)
      VALUES (${userId}::uuid, ${connectionId}::uuid, ${key}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (connection_id, idempotency_key) DO NOTHING`);
    const [job] = await this.db
      .select({ id: integrationJobs.id })
      .from(integrationJobs)
      .where(
        and(
          eq(integrationJobs.userId, userId),
          eq(integrationJobs.connectionId, connectionId),
          eq(integrationJobs.idempotencyKey, key),
        ),
      );
    return job.id;
  }

  async lock(lease: IntegrationLease) {
    const [job] = await this.db
      .select()
      .from(integrationJobs)
      .where(
        and(
          eq(integrationJobs.userId, lease.userId),
          eq(integrationJobs.id, lease.jobId),
          eq(integrationJobs.lease, lease.token),
          eq(integrationJobs.status, 'running'),
          sql`${integrationJobs.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .for('update');
    if (!job) throw new Error('INTEGRATION_LEASE_LOST');
    const [connection] = await this.db
      .select()
      .from(externalConnections)
      .where(
        and(
          eq(externalConnections.userId, lease.userId),
          eq(externalConnections.id, job.connectionId),
          eq(externalConnections.status, 'active'),
        ),
      )
      .for('update');
    if (!connection) throw new Error('INTEGRATION_CONNECTION_PAUSED');
    return { job, connection };
  }

  async checkpoint(
    lease: IntegrationLease,
    checkpoint: unknown,
    done = false,
    errorCode: string | null = null,
    delaySeconds = 0,
  ) {
    const result = await this.db.execute(
      sql`SELECT checkpoint_integration_job(${lease.jobId}::uuid, ${lease.token}::uuid, ${JSON.stringify(checkpoint)}::jsonb, ${done}, ${errorCode}, ${Math.min(86400, Math.max(0, Math.ceil(delaySeconds)))}) AS accepted`,
    );
    if (result[0]?.accepted !== true) throw new Error('INTEGRATION_LEASE_LOST');
  }
}
