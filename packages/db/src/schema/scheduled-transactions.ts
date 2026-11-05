import type { ScheduleAmountChange, StatementDateSource } from '@fc/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { categories } from './categories.ts';
import { domainTypeEnum, frequencyEnum } from './enums.ts';
import { userProfiles } from './users.ts';

export const scheduledTransactions = pgTable(
  'scheduled_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    sourceAccountId: uuid('source_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    destinationAccountId: uuid('destination_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('BRL'),
    description: varchar('description', { length: 500 }).notNull(),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    frequency: frequencyEnum('frequency').notNull(),
    startDate: date('start_date', { mode: 'date' }).notNull(),
    endDate: date('end_date', { mode: 'date' }),
    dueDay: integer('due_day'),
    totalOccurrences: integer('total_occurrences'),
    startingOccurrence: integer('starting_occurrence').notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    domainType: domainTypeEnum('domain_type'),
    domainConfigId: uuid('domain_config_id'),
    isFixedCharge: boolean('is_fixed_charge').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    firstBillingMonth: integer('first_billing_month'),
    firstBillingYear: integer('first_billing_year'),
    amountChanges: jsonb('amount_changes').$type<ScheduleAmountChange[]>().notNull().default([]),
    purchaseDate: date('purchase_date'),
    purchaseDateSource: varchar('purchase_date_source', { length: 20 })
      .$type<StatementDateSource>()
      .notNull()
      .default('unknown'),
  },
  (table) => [
    index('st_user_idx').on(table.userId),
    index('st_user_active_idx').on(table.userId, table.isActive),
    index('st_domain_idx').on(table.domainType, table.domainConfigId),
    index('st_source_idx').on(table.sourceAccountId),
    index('st_dest_idx').on(table.destinationAccountId),
    index('st_category_idx').on(table.categoryId),
    check('sched_amount_positive', sql`${table.amount} > 0`),
    check(
      'sched_purchase_date_source',
      sql`${table.purchaseDateSource} IN ('institution','user','configuration','unknown')`,
    ),
    check(
      'sched_first_billing_both_or_none',
      sql`(${table.firstBillingMonth} IS NULL) = (${table.firstBillingYear} IS NULL)`,
    ),
    check(
      'sched_first_billing_month_valid',
      sql`${table.firstBillingMonth} IS NULL OR ${table.firstBillingMonth} BETWEEN 1 AND 12`,
    ),
  ],
);
