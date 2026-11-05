import type {
  AmountMeaning,
  EventConfirmation,
  PurchaseApplication,
  PurchaseReview,
} from '@fc/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { categories } from './categories.ts';
import { scheduledTransactions } from './scheduled-transactions.ts';
import { transactions } from './transactions.ts';
import { userProfiles } from './users.ts';

export const purchaseObservations = pgTable(
  'purchase_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    cardAccountId: uuid('card_account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    description: varchar('description', { length: 200 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('BRL'),
    amountMeaning: varchar('amount_meaning', { length: 20 })
      .$type<AmountMeaning>()
      .notNull()
      .default('unknown'),
    kind: varchar('kind', { length: 12 })
      .$type<'purchase' | 'refund'>()
      .notNull()
      .default('purchase'),
    confirmation: varchar('confirmation', { length: 12 })
      .$type<EventConfirmation>()
      .notNull()
      .default('observed'),
    review: varchar('review', { length: 16 })
      .$type<PurchaseReview>()
      .notNull()
      .default('unreviewed'),
    manuallyCorrected: boolean('manually_corrected').notNull().default(false),
    unrecognized: boolean('unrecognized').notNull().default(false),
    version: integer('version').notNull().default(1),
    purchaseDate: date('purchase_date'),
    postedDate: date('posted_date'),
    installmentNumber: integer('installment_number'),
    totalInstallments: integer('total_installments'),
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => purchaseObservations.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('purchase_inbox_cursor_idx').on(t.userId, t.createdAt, t.id),
    index('purchase_inbox_review_idx').on(t.userId, t.review, t.createdAt),
    index('purchase_inbox_card_date_idx').on(t.userId, t.cardAccountId, t.purchaseDate),
    check(
      'purchase_values_check',
      sql`${t.amount} > 0 AND ${t.version} > 0 AND ${t.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      'purchase_states_check',
      sql`${t.amountMeaning} IN ('purchase_total','installment','unknown') AND ${t.kind} IN ('purchase','refund') AND ${t.confirmation} IN ('observed','pending','posted','retracted') AND ${t.review} IN ('unreviewed','needs_review','accepted','ignored')`,
    ),
    check(
      'purchase_installments_check',
      sql`(${t.installmentNumber} IS NULL AND ${t.totalInstallments} IS NULL) OR (${t.installmentNumber} IS NOT NULL AND ${t.totalInstallments} IS NOT NULL AND ${t.installmentNumber} BETWEEN 1 AND ${t.totalInstallments} AND ${t.totalInstallments} BETWEEN 1 AND 120)`,
    ),
    check('purchase_merge_not_self', sql`${t.mergedIntoId} IS DISTINCT FROM ${t.id}`),
  ],
);

export const purchaseLedgerLinks = pgTable(
  'purchase_ledger_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    observationId: uuid('observation_id')
      .notNull()
      .references(() => purchaseObservations.id, { onDelete: 'restrict' }),
    transactionId: uuid('transaction_id').references(() => transactions.id, {
      onDelete: 'restrict',
    }),
    scheduleId: uuid('schedule_id').references(() => scheduledTransactions.id, {
      onDelete: 'restrict',
    }),
    billingMonth: integer('billing_month'),
    billingYear: integer('billing_year'),
    application: varchar('application', { length: 10 })
      .$type<Exclude<PurchaseApplication, 'unapplied'>>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('purchase_link_active_observation')
      .on(t.observationId)
      .where(sql`${t.revokedAt} IS NULL`),
    uniqueIndex('purchase_link_active_transaction')
      .on(t.transactionId)
      .where(sql`${t.revokedAt} IS NULL AND ${t.transactionId} IS NOT NULL`),
    uniqueIndex('purchase_link_active_series')
      .on(t.scheduleId)
      .where(
        sql`${t.revokedAt} IS NULL AND ${t.scheduleId} IS NOT NULL AND ${t.billingMonth} IS NULL`,
      ),
    uniqueIndex('purchase_link_active_occurrence')
      .on(t.scheduleId, t.billingYear, t.billingMonth)
      .where(
        sql`${t.revokedAt} IS NULL AND ${t.scheduleId} IS NOT NULL AND ${t.billingMonth} IS NOT NULL`,
      ),
    index('purchase_links_user_idx').on(t.userId, t.observationId),
    check(
      'purchase_link_target_check',
      sql`(${t.transactionId} IS NULL) <> (${t.scheduleId} IS NULL)`,
    ),
    check('purchase_link_application_check', sql`${t.application} IN ('linked','created')`),
    check(
      'purchase_link_period_check',
      sql`(${t.billingMonth} IS NULL AND ${t.billingYear} IS NULL) OR (${t.scheduleId} IS NOT NULL AND ${t.billingMonth} BETWEEN 1 AND 12 AND ${t.billingYear} BETWEEN 2000 AND 2200 AND ${t.billingMonth} IS NOT NULL AND ${t.billingYear} IS NOT NULL)`,
    ),
  ],
);
