import { DOMAIN_TYPE_VALUES, type DomainType } from '@fc/domain';
import {
  ACCOUNT_TYPES,
  CARD_GROUPS,
  CATEGORY_TYPES,
  FREQUENCIES,
  INCOME_CATEGORIES,
  LOAN_CATEGORIES,
  LOAN_TYPES,
  MONTH_STATUSES,
  PAYOFF_CALCULATION_TYPES,
  SHARE_PERMISSIONS,
  TRANSACTION_TYPES,
} from '@fc/shared';
import { z } from 'zod';

export const moneySchema = z
  .string()
  .regex(/^\d+\.\d{2}$/, 'Format must be X.XX')
  .refine((val) => {
    const num = parseFloat(val);
    return num > 0 && num <= 99999999.99;
  }, 'Value must be between 0.01 and 99,999,999.99');

export const moneySchemaAllowNegative = z
  .string()
  .regex(/^-?\d+\.\d{2}$/, 'Format must be X.XX or -X.XX');

/** Cap de texto livre (notes) — evita payloads arbitrariamente grandes. */
export const notesSchema = z.string().max(1000);

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Must be 3 uppercase letters');

export const domainTypeSchema = z.enum([...DOMAIN_TYPE_VALUES] as [DomainType, ...DomainType[]]);

export const accountTypeSchema = z.enum(ACCOUNT_TYPES);
export const transactionTypeSchema = z.enum(TRANSACTION_TYPES);
export const frequencySchema = z.enum(FREQUENCIES);
export const categoryTypeSchema = z.enum(CATEGORY_TYPES);
export const sharePermissionSchema = z.enum(SHARE_PERMISSIONS);
export const monthStatusSchema = z.enum(MONTH_STATUSES);
export const loanCategorySchema = z.enum(LOAN_CATEGORIES);
export const loanTypeSchema = z.enum(LOAN_TYPES);
export const payoffCalculationTypeSchema = z.enum(PAYOFF_CALCULATION_TYPES);
export const cardGroupSchema = z.enum(CARD_GROUPS);
export const incomeCategorySchema = z.enum(INCOME_CATEGORIES);

export const yearSchema = z.number().int().min(2000).max(2100);
export const monthSchema = z.number().int().min(1).max(12);

export const positiveRateSchema = z
  .string()
  .refine((s) => Number.parseFloat(s) > 0, 'Exchange rate must be positive');
