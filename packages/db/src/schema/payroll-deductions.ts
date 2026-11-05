import type { SettlementSnapshot } from '@fc/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { transactions } from './transactions.ts';
import { userProfiles } from './users.ts';

export const payrollDeductions = pgTable(
  'payroll_deductions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    incomeTransactionId: uuid('income_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'restrict' }),
    loanTransactionId: uuid('loan_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    grossIncomeBrl: numeric('gross_income_brl', { precision: 12, scale: 2 }).notNull(),
    incomeBefore: jsonb('income_before').$type<SettlementSnapshot>().notNull(),
    loanBefore: jsonb('loan_before').$type<SettlementSnapshot>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
  },
  (table) => [
    uniqueIndex('payroll_active_loan_unique')
      .on(table.loanTransactionId)
      .where(sql`reversed_at IS NULL`),
    index('payroll_user_income_idx').on(table.userId, table.incomeTransactionId),
    index('payroll_user_created_idx').on(table.userId, table.createdAt),
    check(
      'payroll_amount_positive',
      sql`${table.amount} > 0 AND ${table.grossIncomeBrl} > 0 AND ${table.amount} <= ${table.grossIncomeBrl}`,
    ),
    check(
      'payroll_distinct_occurrences',
      sql`${table.incomeTransactionId} <> ${table.loanTransactionId}`,
    ),
  ],
);
