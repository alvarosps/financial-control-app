import type {
  AccountType,
  CardGroup,
  CategoryType,
  DomainType,
  Frequency,
  IncomeCategory,
  LoanCategory,
  LoanType,
  MonthStatus,
  PayoffCalculationType,
  SharePermission,
  TransactionType,
} from '@fc/shared';
import { expectTypeOf, test } from 'vitest';
import type {
  accountTypeEnum,
  cardGroupEnum,
  categoryTypeEnum,
  domainTypeEnum,
  frequencyEnum,
  incomeCategoryEnum,
  loanCategoryEnum,
  loanTypeEnum,
  monthStatusEnum,
  payoffCalculationTypeEnum,
  sharePermissionEnum,
  transactionTypeEnum,
} from '../schema/enums.ts';

test('accountTypeEnum.enumValues matches @fc/shared AccountType', () => {
  expectTypeOf<(typeof accountTypeEnum.enumValues)[number]>().toEqualTypeOf<AccountType>();
});

test('domainTypeEnum.enumValues matches @fc/shared DomainType', () => {
  expectTypeOf<(typeof domainTypeEnum.enumValues)[number]>().toEqualTypeOf<DomainType>();
});

test('transactionTypeEnum.enumValues matches @fc/shared TransactionType', () => {
  expectTypeOf<(typeof transactionTypeEnum.enumValues)[number]>().toEqualTypeOf<TransactionType>();
});

test('frequencyEnum.enumValues matches @fc/shared Frequency', () => {
  expectTypeOf<(typeof frequencyEnum.enumValues)[number]>().toEqualTypeOf<Frequency>();
});

test('categoryTypeEnum.enumValues matches @fc/shared CategoryType', () => {
  expectTypeOf<(typeof categoryTypeEnum.enumValues)[number]>().toEqualTypeOf<CategoryType>();
});

test('sharePermissionEnum.enumValues matches @fc/shared SharePermission', () => {
  expectTypeOf<(typeof sharePermissionEnum.enumValues)[number]>().toEqualTypeOf<SharePermission>();
});

test('monthStatusEnum.enumValues matches @fc/shared MonthStatus', () => {
  expectTypeOf<(typeof monthStatusEnum.enumValues)[number]>().toEqualTypeOf<MonthStatus>();
});

test('loanCategoryEnum.enumValues matches @fc/shared LoanCategory', () => {
  expectTypeOf<(typeof loanCategoryEnum.enumValues)[number]>().toEqualTypeOf<LoanCategory>();
});

test('loanTypeEnum.enumValues matches @fc/shared LoanType', () => {
  expectTypeOf<(typeof loanTypeEnum.enumValues)[number]>().toEqualTypeOf<LoanType>();
});

test('payoffCalculationTypeEnum.enumValues matches @fc/shared PayoffCalculationType', () => {
  expectTypeOf<
    (typeof payoffCalculationTypeEnum.enumValues)[number]
  >().toEqualTypeOf<PayoffCalculationType>();
});

test('cardGroupEnum.enumValues matches @fc/shared CardGroup', () => {
  expectTypeOf<(typeof cardGroupEnum.enumValues)[number]>().toEqualTypeOf<CardGroup>();
});

test('incomeCategoryEnum.enumValues matches @fc/shared IncomeCategory', () => {
  expectTypeOf<(typeof incomeCategoryEnum.enumValues)[number]>().toEqualTypeOf<IncomeCategory>();
});
