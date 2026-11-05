/**
 * Canonical enum literals shared between `@fc/db` (pgEnum definitions),
 * `@fc/domain` (metadata/labels) and `@fc/api` (tRPC input validation).
 *
 * This module MUST stay a leaf — no runtime dependencies on `@fc/db` or
 * `@fc/domain`, so that web can consume these literals without pulling
 * the Drizzle/postgres stack into the browser bundle.
 */

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'investment',
  'credit_card',
  'loan',
  'personal_debt',
  'expense',
  'revenue',
  'family_loan',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Domain types correspond to the rich metadata object in
 * `@fc/domain/domain-types.ts`. This array is the authoritative runtime
 * source of truth consumed by the Drizzle `domainTypeEnum`. Keep the two
 * in sync — `@fc/domain` asserts equality at the type level.
 */
export const DOMAIN_TYPES = [
  // Credit Card
  'credit_card_installment',
  'credit_card_fixed_charge',
  'credit_card_expense',
  'credit_card_annual_fee',
  'credit_card_refund',
  'bill_payment',
  // Loan
  'loan_payment',
  'loan_insurance',
  // Family Loan
  'family_loan_installment',
  'family_loan_fixed_charge',
  'family_loan_expense',
  'family_loan_discount',
  'family_loan_payment',
  // Recurring
  'recurring_bill',
  // Income
  'income_clt',
  'income_pj',
  'income_freelancer',
  'income_rental',
  'income_family_loan',
  'income_other',
] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];

export const TRANSACTION_TYPES = ['withdrawal', 'deposit', 'transfer'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const FREQUENCIES = [
  'once',
  'weekly',
  'biweekly',
  'monthly',
  'bimonthly',
  'quarterly',
  'semiannual',
  'annual',
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const CATEGORY_TYPES = ['expense', 'revenue', 'transfer'] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];

export const SHARE_PERMISSIONS = ['view', 'edit'] as const;
export type SharePermission = (typeof SHARE_PERMISSIONS)[number];

export const MONTH_STATUSES = ['open', 'review', 'closed'] as const;
export type MonthStatus = (typeof MONTH_STATUSES)[number];

export const LOAN_CATEGORIES = ['bank', 'personal'] as const;
export type LoanCategory = (typeof LOAN_CATEGORIES)[number];

export const LOAN_TYPES = ['consignado', 'pessoal', 'veiculo', 'imobiliario'] as const;
export type LoanType = (typeof LOAN_TYPES)[number];

export const PAYOFF_CALCULATION_TYPES = [
  'consignado_mensal',
  'pessoal_diario',
  'cdc_veiculos',
  'sem_desconto',
] as const;
export type PayoffCalculationType = (typeof PAYOFF_CALCULATION_TYPES)[number];

export const CARD_GROUPS = [
  'credit_card',
  'store_card',
  'grocery',
  'marketplace_loan',
  'vehicle',
] as const;
export type CardGroup = (typeof CARD_GROUPS)[number];

export const INCOME_CATEGORIES = [
  'salary_clt',
  'salary_pj',
  'contractor',
  'rental',
  'investment',
  'freelance',
  'business',
  'other',
] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];
