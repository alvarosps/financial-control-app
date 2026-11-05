import { describe, expect, it } from 'vitest';
import { selectQuickAddAccounts } from './quick-add-selectors';

const accounts = [
  { id: 'w1', name: 'Itaú', type: 'checking', isActive: true },
  { id: 'cc1', name: 'Nubank', type: 'credit_card', isActive: true },
  { id: 'cc2', name: 'Old', type: 'credit_card', isActive: false },
  { id: 'e1', name: 'Despesas Cartão', type: 'expense', isActive: true },
  { id: 'e2', name: 'Despesas Gerais', type: 'expense', isActive: true },
];

describe('selectQuickAddAccounts', () => {
  it('selects active cards and the correct expense ledgers', () => {
    expect(selectQuickAddAccounts(accounts)).toEqual({
      cards: [{ id: 'cc1', name: 'Nubank' }],
      expenseAccountId: 'e2',
      cardExpenseAccountId: 'e1',
    });
  });

  it('falls back safely when expense accounts are missing', () => {
    expect(selectQuickAddAccounts([accounts[0]])).toEqual({
      cards: [],
      expenseAccountId: '',
      cardExpenseAccountId: '',
    });
  });
});
