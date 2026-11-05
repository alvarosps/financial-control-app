import type { StatementDateSource } from '@fc/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';

export const billStatusEnum = pgEnum('bill_status', ['open', 'closed', 'paid', 'partially_paid']);

export const creditCardBills = pgTable(
  'credit_card_bills',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    creditCardAccountId: uuid('credit_card_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    month: integer('month').notNull(),
    year: integer('year').notNull(),
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    status: billStatusEnum('status').notNull().default('open'),
    paidAmount: numeric('paid_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closingDate: date('closing_date'),
    dueDate: date('due_date'),
    closingDateSource: varchar('closing_date_source', { length: 20 })
      .$type<StatementDateSource>()
      .notNull()
      .default('unknown'),
    dueDateSource: varchar('due_date_source', { length: 20 })
      .$type<StatementDateSource>()
      .notNull()
      .default('unknown'),
  },
  (t) => [
    unique('credit_card_bills_unique').on(t.creditCardAccountId, t.month, t.year),
    check('ccb_month_check', sql`${t.month} BETWEEN 1 AND 12`),
    check('ccb_year_check', sql`${t.year} > 0`),
    check(
      'ccb_date_order',
      sql`${t.closingDate} IS NULL OR ${t.dueDate} IS NULL OR ${t.dueDate} >= ${t.closingDate}`,
    ),
    check(
      'ccb_closing_period',
      sql`${t.closingDate} IS NULL OR (EXTRACT(MONTH FROM ${t.closingDate}) = ${t.month} AND EXTRACT(YEAR FROM ${t.closingDate}) = ${t.year})`,
    ),
    check(
      'ccb_date_sources',
      sql`${t.closingDateSource} IN ('institution','user','configuration','unknown') AND ${t.dueDateSource} IN ('institution','user','configuration','unknown')`,
    ),
    check(
      'ccb_paid_consistency',
      sql`(${t.paidAt} IS NULL AND ${t.paidAmount} = 0) OR (${t.paidAt} IS NOT NULL AND ${t.paidAmount} > 0)`,
    ),
  ],
);
