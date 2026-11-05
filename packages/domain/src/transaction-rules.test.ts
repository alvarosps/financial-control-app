import { describe, expect, it } from 'vitest';
import { AccountType } from './account-types.ts';
import {
  deriveTransactionType,
  TransactionType,
  validateTransactionAccounts,
} from './transaction-rules.ts';

describe('deriveTransactionType', () => {
  it('expense → credit_card = withdrawal', () => {
    expect(deriveTransactionType(AccountType.EXPENSE, AccountType.CREDIT_CARD)).toBe(
      TransactionType.WITHDRAWAL,
    );
  });

  it('revenue → checking = deposit', () => {
    expect(deriveTransactionType(AccountType.REVENUE, AccountType.CHECKING)).toBe(
      TransactionType.DEPOSIT,
    );
  });

  it('family_loan → checking = deposit', () => {
    expect(deriveTransactionType(AccountType.FAMILY_LOAN, AccountType.CHECKING)).toBe(
      TransactionType.DEPOSIT,
    );
  });

  it('checking → checking = transfer', () => {
    expect(deriveTransactionType(AccountType.CHECKING, AccountType.CHECKING)).toBe(
      TransactionType.TRANSFER,
    );
  });

  it('checking → credit_card = transfer (bill payment)', () => {
    expect(deriveTransactionType(AccountType.CHECKING, AccountType.CREDIT_CARD)).toBe(
      TransactionType.TRANSFER,
    );
  });

  it('checking → loan = transfer (loan payment)', () => {
    expect(deriveTransactionType(AccountType.CHECKING, AccountType.LOAN)).toBe(
      TransactionType.TRANSFER,
    );
  });

  it('credit_card → checking = transfer (refund)', () => {
    expect(deriveTransactionType(AccountType.CREDIT_CARD, AccountType.CHECKING)).toBe(
      TransactionType.TRANSFER,
    );
  });
});

describe('validateTransactionAccounts', () => {
  it('allows expense → credit_card', () => {
    expect(validateTransactionAccounts(AccountType.EXPENSE, AccountType.CREDIT_CARD)).toEqual({
      valid: true,
    });
  });

  it('allows revenue → checking', () => {
    expect(validateTransactionAccounts(AccountType.REVENUE, AccountType.CHECKING)).toEqual({
      valid: true,
    });
  });

  it('allows checking → credit_card (bill payment)', () => {
    expect(validateTransactionAccounts(AccountType.CHECKING, AccountType.CREDIT_CARD)).toEqual({
      valid: true,
    });
  });

  it('allows checking → loan (loan payment)', () => {
    expect(validateTransactionAccounts(AccountType.CHECKING, AccountType.LOAN)).toEqual({
      valid: true,
    });
  });

  it('rejects expense → expense', () => {
    const result = validateTransactionAccounts(AccountType.EXPENSE, AccountType.EXPENSE);
    expect(result.valid).toBe(false);
  });

  it('rejects revenue → revenue', () => {
    const result = validateTransactionAccounts(AccountType.REVENUE, AccountType.REVENUE);
    expect(result.valid).toBe(false);
  });

  it('rejects expense → revenue', () => {
    const result = validateTransactionAccounts(AccountType.EXPENSE, AccountType.REVENUE);
    expect(result.valid).toBe(false);
  });

  it('rejects expense → family_loan', () => {
    const result = validateTransactionAccounts(AccountType.EXPENSE, AccountType.FAMILY_LOAN);
    expect(result.valid).toBe(false);
  });
});
