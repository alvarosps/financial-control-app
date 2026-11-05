import { type AccountType, getAccountGroup } from './account-types.ts';

export const TransactionType = {
  WITHDRAWAL: 'withdrawal',
  DEPOSIT: 'deposit',
  TRANSFER: 'transfer',
} as const;

export type TransactionType = (typeof TransactionType)[keyof typeof TransactionType];

export function deriveTransactionType(
  sourceType: AccountType,
  _destType: AccountType,
): TransactionType {
  const sourceGroup = getAccountGroup(sourceType);

  if (sourceGroup === 'expense') return TransactionType.WITHDRAWAL;
  if (sourceGroup === 'revenue') return TransactionType.DEPOSIT;
  return TransactionType.TRANSFER;
}

type ValidationResult = { valid: true } | { valid: false; reason: string };

export function validateTransactionAccounts(
  sourceType: AccountType,
  destType: AccountType,
): ValidationResult {
  const sourceGroup = getAccountGroup(sourceType);
  const destGroup = getAccountGroup(destType);

  if (sourceGroup === destGroup && (sourceGroup === 'expense' || sourceGroup === 'revenue')) {
    return { valid: false, reason: `Cannot transact between two ${sourceGroup} accounts` };
  }

  if (destGroup === 'expense') {
    return { valid: false, reason: 'Expense accounts can only be transaction sources' };
  }

  if (sourceGroup !== 'revenue' && sourceGroup !== 'expense' && destGroup === 'revenue') {
    return { valid: false, reason: 'Revenue accounts can only be transaction sources' };
  }

  // expense source can only target asset or liability accounts
  if (sourceGroup === 'expense' && destGroup === 'revenue') {
    return { valid: false, reason: 'Expense accounts cannot transact with revenue accounts' };
  }

  return { valid: true };
}
