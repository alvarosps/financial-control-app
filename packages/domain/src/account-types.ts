export const AccountType = {
  CHECKING: 'checking',
  SAVINGS: 'savings',
  INVESTMENT: 'investment',
  CREDIT_CARD: 'credit_card',
  LOAN: 'loan',
  PERSONAL_DEBT: 'personal_debt',
  EXPENSE: 'expense',
  REVENUE: 'revenue',
  FAMILY_LOAN: 'family_loan',
} as const;

export type AccountType = (typeof AccountType)[keyof typeof AccountType];

const ASSET_TYPES: ReadonlySet<AccountType> = new Set([
  AccountType.CHECKING,
  AccountType.SAVINGS,
  AccountType.INVESTMENT,
]);

const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set([
  AccountType.CREDIT_CARD,
  AccountType.LOAN,
  AccountType.PERSONAL_DEBT,
]);

const VIRTUAL_TYPES: ReadonlySet<AccountType> = new Set([
  AccountType.EXPENSE,
  AccountType.REVENUE,
  AccountType.FAMILY_LOAN,
]);

export type AccountGroup = 'asset' | 'liability' | 'expense' | 'revenue';

export function isAssetAccount(type: AccountType): boolean {
  return ASSET_TYPES.has(type);
}

export function isLiabilityAccount(type: AccountType): boolean {
  return LIABILITY_TYPES.has(type);
}

export function isVirtualAccount(type: AccountType): boolean {
  return VIRTUAL_TYPES.has(type);
}

const ACCOUNT_GROUP_MAP: ReadonlyMap<AccountType, AccountGroup> = new Map([
  [AccountType.CHECKING, 'asset'],
  [AccountType.SAVINGS, 'asset'],
  [AccountType.INVESTMENT, 'asset'],
  [AccountType.CREDIT_CARD, 'liability'],
  [AccountType.LOAN, 'liability'],
  [AccountType.PERSONAL_DEBT, 'liability'],
  [AccountType.EXPENSE, 'expense'],
  [AccountType.REVENUE, 'revenue'],
  [AccountType.FAMILY_LOAN, 'revenue'],
]);

export function getAccountGroup(type: AccountType): AccountGroup {
  const group = ACCOUNT_GROUP_MAP.get(type);
  if (!group) {
    throw new Error(`Unknown account type: ${type}`);
  }
  return group;
}
