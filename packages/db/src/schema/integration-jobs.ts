import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { externalConnections } from './external-connections.ts';
import { userProfiles } from './users.ts';

export const integrationJobs = pgTable(
  'integration_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => externalConnections.id, { onDelete: 'cascade' }),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    payload: jsonb('payload').$type<unknown>().notNull().default({}),
    checkpoint: jsonb('checkpoint').$type<unknown>().notNull().default({}),
    status: varchar('status', { length: 12 })
      .$type<'pending' | 'running' | 'completed' | 'failed'>()
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lease: uuid('lease'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    errorCode: varchar('error_code', { length: 80 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('integration_job_idempotency').on(t.connectionId, t.idempotencyKey),
    index('integration_job_ready_idx').on(t.status, t.nextAttemptAt),
    index('integration_job_owner_idx').on(t.userId),
    check(
      'integration_job_values',
      sql`${t.status} IN ('pending','running','completed','failed') AND ${t.attempts} >= 0 AND ((${t.lease} IS NULL AND ${t.leaseExpiresAt} IS NULL) OR (${t.lease} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL))`,
    ),
  ],
);

export const integrationIngressBuckets = pgTable(
  'integration_ingress_buckets',
  {
    bucket: varchar('bucket', { length: 12 }).primaryKey(),
    windowAt: timestamp('window_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull(),
  },
  (t) => [
    check(
      'integration_ingress_values',
      sql`${t.bucket} IN ('webhook','scheduler') AND ${t.attempts} >= 0`,
    ),
  ],
);
