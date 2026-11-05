import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { userProfiles } from './users.ts';

export const captureDevices = pgTable(
  'capture_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }),
    rateWindowAt: timestamp('rate_window_at', { withTimezone: true }).notNull().defaultNow(),
    rateCount: integer('rate_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('capture_device_token_unique').on(t.tokenHash),
    index('capture_device_owner_idx').on(t.userId),
    check(
      'capture_device_values',
      sql`${t.tokenHash} ~ '^[a-f0-9]{64}$' AND length(${t.name}) > 0 AND ${t.rateCount} >= 0`,
    ),
  ],
);

export const capturePairingCodes = pgTable(
  'capture_pairing_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => captureDevices.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('capture_pair_code_unique').on(t.codeHash),
    index('capture_pair_owner_idx').on(t.userId, t.createdAt),
    check('capture_pair_values', sql`${t.codeHash} ~ '^[a-f0-9]{64}$' AND length(${t.name}) > 0`),
  ],
);

export const captureIngressBuckets = pgTable(
  'capture_ingress_buckets',
  {
    bucket: varchar('bucket', { length: 10 }).primaryKey(),
    windowAt: timestamp('window_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull(),
  },
  (t) => [
    check('capture_ingress_values', sql`${t.bucket} IN ('pair','events') AND ${t.attempts} >= 0`),
  ],
);
