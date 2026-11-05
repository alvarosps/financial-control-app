import type { FinancialEventData, FinancialEventSource } from '@fc/shared';
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
import { purchaseObservations } from './purchase-observations.ts';
import { userProfiles } from './users.ts';

export const financialEvents = pgTable(
  'financial_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    observationId: uuid('observation_id')
      .notNull()
      .references(() => purchaseObservations.id, { onDelete: 'restrict' }),
    source: varchar('source', { length: 12 }).$type<FinancialEventSource>().notNull(),
    sourceScope: varchar('source_scope', { length: 128 }).notNull(),
    externalId: varchar('external_id', { length: 200 }).notNull(),
    currentVersion: integer('current_version').notNull(),
    currentHash: varchar('current_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('financial_event_identity').on(t.userId, t.source, t.sourceScope, t.externalId),
    index('financial_event_observation_idx').on(t.userId, t.observationId),
    check(
      'financial_event_source_check',
      sql`${t.source} IN ('manual','pdf','android','pluggy') AND ${t.currentVersion} > 0 AND length(${t.sourceScope}) > 0 AND length(${t.externalId}) > 0 AND ${t.currentHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const financialEventRevisions = pgTable(
  'financial_event_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => financialEvents.id, { onDelete: 'cascade' }),
    sourceVersion: integer('source_version').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    parserVersion: varchar('parser_version', { length: 80 }).notNull(),
    data: jsonb('data').$type<FinancialEventData>().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('financial_event_revision_unique').on(t.eventId, t.sourceVersion),
    index('financial_event_revision_user_idx').on(t.userId, t.eventId),
    check(
      'financial_revision_values_check',
      sql`${t.sourceVersion} > 0 AND ${t.contentHash} ~ '^[a-f0-9]{64}$' AND length(${t.parserVersion}) > 0 AND jsonb_typeof(${t.data}) = 'object'`,
    ),
  ],
);
