import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { userProfiles } from './users.ts';

export type FinancialAlertRule =
  | 'stale_statement'
  | 'reconciliation_difference'
  | 'unrecognized_purchase'
  | 'budget_near'
  | 'budget_exceeded'
  | 'projected_commitment'
  | 'recurring_candidate'
  | 'recurring_price'
  | 'cash_coverage';
export type FinancialAlertEvidence = {
  label: string;
  amount?: string;
  limit?: string;
  previousAmount?: string;
  sampleDates?: string[];
  sampleIds?: string[];
  count?: number;
  reason?: string;
  toleranceAmount?: string;
  basis?: string;
};
export const financialAlerts = pgTable(
  'financial_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    rule: varchar('rule', { length: 32 }).$type<FinancialAlertRule>().notNull(),
    entityKey: varchar('entity_key', { length: 128 }).notNull(),
    month: integer('month').notNull(),
    year: integer('year').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    revision: integer('revision').notNull().default(1),
    evidence: jsonb('evidence').$type<FinancialAlertEvidence>().notNull(),
    state: varchar('state', { length: 12 })
      .$type<'open' | 'read' | 'muted' | 'resolved'>()
      .notNull()
      .default('open'),
    active: boolean('active').notNull().default(true),
    readAt: timestamp('read_at', { withTimezone: true }),
    mutedAt: timestamp('muted_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('financial_alerts_identity').on(t.userId, t.rule, t.entityKey, t.year, t.month),
    index('financial_alerts_owner_state').on(t.userId, t.state, t.year, t.month),
    check(
      'financial_alerts_values',
      sql`${t.month} BETWEEN 1 AND 12 AND ${t.year} BETWEEN 2000 AND 2200 AND ${t.revision}>0 AND ${t.contentHash} ~ '^[a-f0-9]{64}$' AND jsonb_typeof(${t.evidence})='object' AND ${t.state} IN ('open','read','muted','resolved') AND ${t.rule} IN ('stale_statement','reconciliation_difference','unrecognized_purchase','budget_near','budget_exceeded','projected_commitment','recurring_candidate','recurring_price','cash_coverage')`,
    ),
  ],
);
