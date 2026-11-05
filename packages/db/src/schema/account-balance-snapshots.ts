import { sql } from 'drizzle-orm';
import { check, integer, numeric, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';

export const accountBalanceSnapshots = pgTable(
  'account_balance_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    month: integer('month').notNull(),
    year: integer('year').notNull(),
    balance: numeric('balance', { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('account_balance_snapshots_unique').on(t.accountId, t.month, t.year),
    check('abs_month_check', sql`${t.month} BETWEEN 1 AND 12`),
    check('abs_year_check', sql`${t.year} > 0`),
  ],
);
