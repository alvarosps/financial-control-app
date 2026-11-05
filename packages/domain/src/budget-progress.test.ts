import { describe, expect, it } from 'vitest';
import { type BudgetExpense, budgetProgress } from './budget-progress.ts';

const expense = (fields: Partial<BudgetExpense> = {}): BudgetExpense => ({
  amount: '100.00',
  currency: 'BRL',
  categoryId: 'food',
  responsibility: 'unknown',
  phase: 'confirmed',
  refund: false,
  reviewed: true,
  ...fields,
});
describe('budgetProgress', () => {
  it('keeps confirmed, committed and provisional separate and subtracts refunds', () => {
    const result = budgetProgress(
      '500.00',
      null,
      'all',
      [
        expense(),
        expense({ amount: '25.50', refund: true }),
        expense({ phase: 'committed', amount: '200.00' }),
        expense({ phase: 'provisional', amount: '12.30' }),
      ],
      true,
    );
    expect(result).toMatchObject({
      confirmed: '74.50',
      committed: '200.00',
      provisional: '12.30',
      remaining: '213.20',
      reliable: false,
    });
  });
  it('excludes only explicitly other-owned expense, preserving unknown and uncategorized totals', () => {
    const result = budgetProgress(
      '1000.00',
      null,
      'own',
      [
        expense(),
        expense({ responsibility: 'family' }),
        expense({ responsibility: 'work' }),
        expense({ categoryId: null, amount: '33.33', reviewed: false }),
      ],
      true,
    );
    expect(result).toMatchObject({
      confirmed: '133.33',
      unknownResponsibility: '133.33',
      uncategorized: '33.33',
      excluded: '200.00',
      reliable: false,
    });
  });
  it('filters categories, refuses currency coercion and does not claim reliable surplus below coverage', () => {
    const result = budgetProgress(
      '200.00',
      'food',
      'all',
      [expense(), expense({ categoryId: 'work' }), expense({ currency: 'USD' })],
      true,
    );
    expect(result).toMatchObject({
      confirmed: '100.00',
      unsupportedCurrencyCount: 1,
      reliable: false,
    });
    expect(
      budgetProgress('200.00', 'food', 'all', [expense({ responsibility: 'own' })], true),
    ).toMatchObject({ reliable: true, remaining: '100.00' });
  });
});
