import { SYSTEM_ACCOUNT_NAMES } from '@fc/shared';

export type QuickAddAccountRow = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
};

export function selectQuickAddAccounts(accounts: QuickAddAccountRow[]) {
  const active = accounts.filter((account) => account.isActive);
  const expenses = active.filter((account) => account.type === 'expense');
  const genericExpense =
    expenses.find((account) => account.name !== SYSTEM_ACCOUNT_NAMES.CREDIT_CARD_EXPENSES) ??
    expenses[0];
  const cardExpense =
    expenses.find((account) => account.name === SYSTEM_ACCOUNT_NAMES.CREDIT_CARD_EXPENSES) ??
    genericExpense;

  return {
    cards: active
      .filter((account) => account.type === 'credit_card')
      .map(({ id, name }) => ({ id, name })),
    expenseAccountId: genericExpense?.id ?? '',
    cardExpenseAccountId: cardExpense?.id ?? '',
  };
}
