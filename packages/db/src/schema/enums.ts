import {
  ACCOUNT_TYPES,
  CARD_GROUPS,
  CATEGORY_TYPES,
  DOMAIN_TYPES,
  FREQUENCIES,
  INCOME_CATEGORIES,
  LOAN_CATEGORIES,
  LOAN_TYPES,
  MONTH_STATUSES,
  PAYOFF_CALCULATION_TYPES,
  SHARE_PERMISSIONS,
  TRANSACTION_TYPES,
} from '@fc/shared';
import { pgEnum } from 'drizzle-orm/pg-core';

// Drizzle's `pgEnum` accepts `Readonly<[U, ...U[]]>`, which matches the
// `as const` readonly tuples exported from `@fc/shared`. The inferred
// `.enumValues` therefore carries the exact literal union — asserted by the
// type-parity test in `__tests__/enum-parity.test-d.ts`.
export const accountTypeEnum = pgEnum('account_type', ACCOUNT_TYPES);
export const domainTypeEnum = pgEnum('domain_type', DOMAIN_TYPES);
export const transactionTypeEnum = pgEnum('transaction_type', TRANSACTION_TYPES);
export const frequencyEnum = pgEnum('frequency', FREQUENCIES);
export const categoryTypeEnum = pgEnum('category_type', CATEGORY_TYPES);
export const sharePermissionEnum = pgEnum('share_permission', SHARE_PERMISSIONS);
export const monthStatusEnum = pgEnum('month_status', MONTH_STATUSES);
export const loanCategoryEnum = pgEnum('loan_category', LOAN_CATEGORIES);
export const loanTypeEnum = pgEnum('loan_type', LOAN_TYPES);
export const payoffCalculationTypeEnum = pgEnum(
  'payoff_calculation_type',
  PAYOFF_CALCULATION_TYPES,
);
export const cardGroupEnum = pgEnum('card_group', CARD_GROUPS);
export const incomeCategoryEnum = pgEnum('income_category', INCOME_CATEGORIES);
