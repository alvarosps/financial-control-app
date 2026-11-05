import type { SettlementSource, StatementDateSource } from '@fc/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { categories } from './categories.ts';
import { type ClassificationState, classificationRules } from './classification-rules.ts';
import { domainTypeEnum, transactionTypeEnum } from './enums.ts';
import { scheduledTransactions } from './scheduled-transactions.ts';
import { userProfiles } from './users.ts';

export const transactions = pgTable(
  'transactions',
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
    type: transactionTypeEnum('type').notNull(),
    description: varchar('description', { length: 500 }).notNull(),
    date: date('date', { mode: 'date' }).notNull(),
    notes: text('notes'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    billingMonth: integer('billing_month'),
    billingYear: integer('billing_year'),
    installmentNumber: integer('installment_number'),
    totalInstallments: integer('total_installments'),
    isPaid: boolean('is_paid').notNull().default(false),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidFromAccountId: uuid('paid_from_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    isReversed: boolean('is_reversed').notNull().default(false),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedByTransactionId: uuid('reversed_by_transaction_id').references(
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle requires `any` for self-referential foreign keys
      (): any => transactions.id,
      { onDelete: 'set null' },
    ),
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle requires `any` for self-referential foreign keys
    reversesTransactionId: uuid('reverses_transaction_id').references((): any => transactions.id, {
      onDelete: 'set null',
    }),
    scheduledTransactionId: uuid('scheduled_transaction_id').references(
      () => scheduledTransactions.id,
      { onDelete: 'set null' },
    ),
    domainType: domainTypeEnum('domain_type'),
    exchangeRate: numeric('exchange_rate', { precision: 10, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    purchaseDate: date('purchase_date'),
    postedDate: date('posted_date'),
    purchaseDateSource: varchar('purchase_date_source', { length: 20 })
      .$type<StatementDateSource>()
      .notNull()
      .default('unknown'),
    postedDateSource: varchar('posted_date_source', { length: 20 })
      .$type<StatementDateSource>()
      .notNull()
      .default('unknown'),
    isAmountOverridden: boolean('is_amount_overridden').notNull().default(false),
    cashAmount: numeric('cash_amount', { precision: 12, scale: 2 }),
    settlementSource: varchar('settlement_source', { length: 20 })
      .$type<SettlementSource>()
      .notNull()
      .default('legacy'),
    settlementDate: timestamp('settlement_date', { withTimezone: true }),
    classificationSource: varchar('classification_source', { length: 12 })
      .$type<ClassificationState['classificationSource']>()
      .notNull()
      .default('unreviewed'),
    classificationRuleId: uuid('classification_rule_id').references(() => classificationRules.id, {
      onDelete: 'restrict',
    }),
    classificationRuleVersion: integer('classification_rule_version'),
    classificationConfidence: varchar('classification_confidence', { length: 12 }).$type<
      ClassificationState['classificationConfidence']
    >(),
    classificationReviewedAt: timestamp('classification_reviewed_at', { withTimezone: true }),
    economicResponsibility: varchar('economic_responsibility', { length: 12 })
      .$type<ClassificationState['economicResponsibility']>()
      .notNull()
      .default('unknown'),
    receivableAccountId: uuid('receivable_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => [
    check(
      'tx_classification_values',
      sql`${table.classificationSource} IN ('unreviewed','manual','rule') AND ${table.economicResponsibility} IN ('unknown','own','family','work','property') AND (${table.classificationConfidence} IS NULL OR ${table.classificationConfidence} IN ('exact','ambiguous')) AND ((${table.classificationSource} = 'unreviewed' AND ${table.classificationReviewedAt} IS NULL) OR (${table.classificationSource} <> 'unreviewed' AND ${table.classificationReviewedAt} IS NOT NULL)) AND ((${table.classificationRuleId} IS NULL AND ${table.classificationRuleVersion} IS NULL AND ${table.classificationSource} <> 'rule') OR (${table.classificationRuleId} IS NOT NULL AND ${table.classificationRuleVersion} > 0 AND ${table.classificationSource} = 'rule'))`,
    ),
    index('tx_user_date_idx').on(table.userId, table.date),
    index('tx_source_idx').on(table.sourceAccountId, table.date),
    index('tx_dest_idx').on(table.destinationAccountId, table.date),
    index('tx_billing_idx').on(table.destinationAccountId, table.billingMonth, table.billingYear),
    index('tx_user_paid_idx').on(table.userId, table.isPaid, table.date),
    index('tx_scheduled_idx').on(table.scheduledTransactionId),
    index('tx_domain_type_idx').on(table.domainType, table.userId),
    index('tx_user_billing_idx').on(table.userId, table.billingMonth, table.billingYear),
    index('tx_category_idx').on(table.categoryId).where(sql`category_id IS NOT NULL`),
    index('tx_paid_from_idx')
      .on(table.paidFromAccountId)
      .where(sql`paid_from_account_id IS NOT NULL`),
    check('tx_amount_positive', sql`${table.amount} > 0`),
    check(
      'tx_cash_amount_nonnegative',
      sql`${table.cashAmount} IS NULL OR ${table.cashAmount} >= 0`,
    ),
    check(
      'tx_settlement_source',
      sql`${table.settlementSource} IN ('manual','bank','payroll','date_assumed','legacy')`,
    ),
    index('tx_user_settlement_idx').on(table.userId, table.settlementDate),
    check(
      'tx_statement_date_sources',
      sql`${table.purchaseDateSource} IN ('institution','user','configuration','unknown') AND ${table.postedDateSource} IN ('institution','user','configuration','unknown')`,
    ),
    check(
      'chk_transactions_billing_month',
      sql`${table.billingMonth} IS NULL OR (${table.billingMonth} BETWEEN 1 AND 12)`,
    ),
    check(
      'chk_transactions_billing_pair',
      sql`(${table.billingMonth} IS NULL) = (${table.billingYear} IS NULL)`,
    ),
    check(
      'chk_transactions_billing_year_positive',
      sql`${table.billingYear} IS NULL OR ${table.billingYear} > 0`,
    ),
    uniqueIndex('tx_bill_payment_unique')
      .on(table.destinationAccountId, table.billingMonth, table.billingYear)
      .where(
        sql`domain_type = 'bill_payment' AND is_reversed = false AND billing_year IS NOT NULL`,
      ),
    // Materializer idempotency backstop: a schedule produces at most one
    // non-reversed row per calendar date (computeOccurrenceDates never emits two
    // same-date occurrences). Prevents racing/concurrent materialize() runs from
    // inserting duplicate schedule-linked rows. Manual rows (NULL link) are
    // excluded — those are deduped in-application by content key.
    uniqueIndex('tx_materialized_unique')
      .on(table.scheduledTransactionId, table.date)
      .where(sql`scheduled_transaction_id IS NOT NULL AND is_reversed = false`),
  ],
);
