import { describe, expect, it } from 'vitest';
import {
  AccountType,
  getAccountGroup,
  isAssetAccount,
  isLiabilityAccount,
  isVirtualAccount,
} from './account-types.ts';

describe('AccountType', () => {
  it('checking is an asset account', () => {
    expect(isAssetAccount(AccountType.CHECKING)).toBe(true);
    expect(isLiabilityAccount(AccountType.CHECKING)).toBe(false);
  });

  it('savings is an asset account', () => {
    expect(isAssetAccount(AccountType.SAVINGS)).toBe(true);
  });

  it('credit_card is a liability account', () => {
    expect(isLiabilityAccount(AccountType.CREDIT_CARD)).toBe(true);
    expect(isAssetAccount(AccountType.CREDIT_CARD)).toBe(false);
  });

  it('loan is a liability account', () => {
    expect(isLiabilityAccount(AccountType.LOAN)).toBe(true);
  });

  it('expense is a virtual account', () => {
    expect(isVirtualAccount(AccountType.EXPENSE)).toBe(true);
  });

  it('revenue is a virtual account', () => {
    expect(isVirtualAccount(AccountType.REVENUE)).toBe(true);
  });

  it('family_loan groups as revenue', () => {
    expect(getAccountGroup(AccountType.FAMILY_LOAN)).toBe('revenue');
  });

  it('getAccountGroup returns correct groups', () => {
    expect(getAccountGroup(AccountType.CHECKING)).toBe('asset');
    expect(getAccountGroup(AccountType.CREDIT_CARD)).toBe('liability');
    expect(getAccountGroup(AccountType.EXPENSE)).toBe('expense');
    expect(getAccountGroup(AccountType.REVENUE)).toBe('revenue');
  });
});
