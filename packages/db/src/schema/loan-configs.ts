import type { LoanPaymentMethod } from '@fc/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { loanCategoryEnum, loanTypeEnum, payoffCalculationTypeEnum } from './enums.ts';

export const loanConfigs = pgTable(
  'loan_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' })
      .unique(),
    loanCategory: loanCategoryEnum('loan_category').notNull(),
    loanType: loanTypeEnum('loan_type').notNull(),
    totalInstallments: integer('total_installments').notNull(),
    monthlyPayment: numeric('monthly_payment', { precision: 12, scale: 2 }).notNull(),
    dueDay: integer('due_day').notNull(),
    monthlyInterestRate: numeric('monthly_interest_rate', { precision: 10, scale: 8 }).notNull(),
    annualInterestRate: numeric('annual_interest_rate', { precision: 10, scale: 8 }),
    insuranceAmount: numeric('insurance_amount', { precision: 12, scale: 2 }),
    insurancePaymentDay: integer('insurance_payment_day'),
    payoffCalculationType: payoffCalculationTypeEnum('payoff_calculation_type'),
    principalAmount: numeric('principal_amount', { precision: 12, scale: 2 }),
    originalAmount: numeric('original_amount', { precision: 12, scale: 2 }),
    startDate: date('start_date', { mode: 'date' }),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    paymentMethod: varchar('payment_method', { length: 20 }).$type<LoanPaymentMethod>(),
    incomeSourceAccountId: uuid('income_source_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    annualCet: numeric('annual_cet', { precision: 10, scale: 8 }),
    annualCetSource: varchar('annual_cet_source', { length: 200 }),
    annualCetObservedOn: date('annual_cet_observed_on'),
    payoffQuoteAmount: numeric('payoff_quote_amount', { precision: 12, scale: 2 }),
    payoffQuoteOn: date('payoff_quote_on'),
    payoffQuoteValidUntil: date('payoff_quote_valid_until'),
    payoffQuoteSource: varchar('payoff_quote_source', { length: 200 }),
    economicResponsibility: varchar('economic_responsibility', { length: 12 })
      .$type<'unknown' | 'own' | 'family' | 'work' | 'property'>()
      .notNull()
      .default('unknown'),
  },
  (table) => [
    check(
      'loan_cost_evidence',
      sql`((${table.annualCet} IS NULL AND ${table.annualCetSource} IS NULL AND ${table.annualCetObservedOn} IS NULL) OR (${table.annualCet} IS NOT NULL AND ${table.annualCet} >= 0 AND ${table.annualCetSource} IS NOT NULL AND length(btrim(${table.annualCetSource})) > 0 AND ${table.annualCetObservedOn} IS NOT NULL)) AND ((${table.payoffQuoteAmount} IS NULL AND ${table.payoffQuoteOn} IS NULL AND ${table.payoffQuoteValidUntil} IS NULL AND ${table.payoffQuoteSource} IS NULL) OR (${table.payoffQuoteAmount} IS NOT NULL AND ${table.payoffQuoteAmount}>0 AND ${table.payoffQuoteOn} IS NOT NULL AND ${table.payoffQuoteValidUntil} IS NOT NULL AND ${table.payoffQuoteValidUntil} >= ${table.payoffQuoteOn} AND ${table.payoffQuoteSource} IS NOT NULL AND length(btrim(${table.payoffQuoteSource}))>0)) AND ${table.economicResponsibility} IN ('unknown','own','family','work','property')`,
    ),
    check(
      'loan_payment_method',
      sql`${table.paymentMethod} IS NULL OR ${table.paymentMethod} IN ('bank_debit','payroll','manual')`,
    ),
    check(
      'loan_payroll_source',
      sql`${table.incomeSourceAccountId} IS NULL OR ${table.paymentMethod} = 'payroll'`,
    ),
    index('loan_income_source_idx').on(table.incomeSourceAccountId),
  ],
);
