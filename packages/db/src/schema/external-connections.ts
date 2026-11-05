import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { userProfiles } from './users.ts';

export const externalConnections = pgTable(
  'external_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    status: varchar('status', { length: 20 })
      .$type<'active' | 'paused' | 'auth_required' | 'error'>()
      .notNull()
      .default('active'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    errorCode: varchar('error_code', { length: 80 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_connection_item_unique').on(t.itemId),
    index('external_connection_owner_idx').on(t.userId),
    check(
      'external_connection_status',
      sql`${t.status} IN ('active','paused','auth_required','error')`,
    ),
  ],
);

export const externalAccounts = pgTable(
  'external_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => externalConnections.id, { onDelete: 'cascade' }),
    externalId: uuid('external_id').notNull(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    kind: varchar('kind', { length: 8 }).$type<'BANK' | 'CREDIT'>().notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    balance: numeric('balance', { precision: 14, scale: 2 }),
    balanceType: varchar('balance_type', { length: 16 })
      .$type<'unknown' | 'book' | 'available' | 'limit'>()
      .notNull()
      .default('unknown'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    balanceAsOf: timestamp('balance_as_of', { withTimezone: true }),
    movementRevision: integer('movement_revision').notNull().default(0),
  },
  (t) => [
    uniqueIndex('external_account_provider_unique').on(t.externalId),
    index('external_account_owner_idx').on(t.userId, t.connectionId),
    uniqueIndex('external_account_mapping_unique')
      .on(t.accountId)
      .where(sql`${t.accountId} IS NOT NULL`),
    check(
      'external_account_values',
      sql`${t.kind} IN ('BANK','CREDIT') AND ${t.currency} ~ '^[A-Z]{3}$' AND ${t.balanceType} IN ('unknown','book','available','limit')`,
    ),
  ],
);

export const externalMovements = pgTable(
  'external_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    externalAccountId: uuid('external_account_id')
      .notNull()
      .references(() => externalAccounts.id, { onDelete: 'cascade' }),
    externalId: uuid('external_id').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    version: integer('version').notNull().default(1),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    reviewedVersion: integer('reviewed_version'),
  },
  (t) => [
    uniqueIndex('external_movement_identity').on(t.externalAccountId, t.externalId),
    index('external_movement_owner_idx').on(t.userId, t.externalAccountId),
    check(
      'external_movement_values',
      sql`${t.version} > 0 AND ${t.contentHash} ~ '^[a-f0-9]{64}$' AND (${t.reviewedVersion} IS NULL OR ${t.reviewedVersion} BETWEEN 1 AND ${t.version})`,
    ),
  ],
);

export const externalBills = pgTable(
  'external_bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    externalAccountId: uuid('external_account_id')
      .notNull()
      .references(() => externalAccounts.id, { onDelete: 'cascade' }),
    externalId: uuid('external_id').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_bill_identity').on(t.externalAccountId, t.externalId),
    index('external_bill_owner_idx').on(t.userId),
  ],
);
