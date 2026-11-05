import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { monthStatusEnum } from './enums.ts';
import { userProfiles } from './users.ts';

export const monthClosings = pgTable(
  'month_closings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    month: integer('month').notNull(),
    year: integer('year').notNull(),
    status: monthStatusEnum('status').notNull().default('open'),
    totalIncome: numeric('total_income', { precision: 12, scale: 2 }),
    totalExpenses: numeric('total_expenses', { precision: 12, scale: 2 }),
    totalBalance: numeric('total_balance', { precision: 12, scale: 2 }),
    detailedBreakdown: jsonb('detailed_breakdown'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: integer('revision').notNull().default(0),
  },
  (table) => [
    unique('month_closings_unique').on(table.userId, table.month, table.year),
    index('month_closings_user_id_idx').on(table.userId),
    check('month_closings_month_check', sql`${table.month} BETWEEN 1 AND 12`),
    check('month_closings_year_check', sql`${table.year} > 0`),
  ],
);

export const monthClosingVersions = pgTable(
  'month_closing_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    month: integer('month').notNull(),
    year: integer('year').notNull(),
    revision: integer('revision').notNull(),
    action: text('action').$type<'closed' | 'reopened'>().notNull(),
    snapshot: jsonb('snapshot').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('month_closing_version_unique').on(t.userId, t.month, t.year, t.revision),
    check(
      'month_closing_version_values',
      sql`${t.month} BETWEEN 1 AND 12 AND ${t.year} > 0 AND ${t.revision} > 0 AND ${t.action} IN ('closed','reopened') AND length(btrim(${t.reason})) >= 3 AND jsonb_typeof(${t.snapshot}) = 'object'`,
    ),
  ],
);
