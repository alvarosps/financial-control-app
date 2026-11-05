import { describe, expect, it } from 'vitest';
import { suggestNewItemActions } from './recurring.ts';
import type { HistoryItem, ParsedItem } from './types.ts';

function item(overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    description: 'GOOGLE ONE',
    amountBRL: '11.99',
    purchaseDate: null,
    installmentCurrent: null,
    installmentTotal: null,
    isRefund: false,
    cardLastFour: null,
    holderName: null,
    isAdditional: false,
    ...overrides,
  };
}

function history(month: number, overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    description: 'Google One',
    amountBRL: '11.99',
    billingMonth: month,
    billingYear: 2026,
    domainType: 'credit_card_expense',
    ...overrides,
  };
}

describe('suggestNewItemActions', () => {
  it('suggests a refund for statement credits', () => {
    expect(suggestNewItemActions([item({ isRefund: true })], [])[0]).toMatchObject({
      suggestedKind: 'add_refund',
      looksRecurring: false,
    });
  });

  it('suggests an installment series when k/n is present', () => {
    expect(
      suggestNewItemActions([item({ installmentCurrent: 3, installmentTotal: 10 })], [])[0]
        ?.suggestedKind,
    ).toBe('add_installment');
  });

  it('suggests a fixed charge after matching two distinct previous months', () => {
    expect(suggestNewItemActions([item()], [history(4), history(5)])[0]).toMatchObject({
      suggestedKind: 'add_fixed_charge',
      looksRecurring: true,
    });
  });

  it('does not treat one previous month or two rows in one month as recurring', () => {
    expect(suggestNewItemActions([item()], [history(5)])[0]?.suggestedKind).toBe('add_expense');
    expect(suggestNewItemActions([item()], [history(5), history(5)])[0]?.suggestedKind).toBe(
      'add_expense',
    );
  });

  it('does not treat materially different amounts as recurring', () => {
    expect(
      suggestNewItemActions(
        [item()],
        [history(4, { amountBRL: '250.00' }), history(5, { amountBRL: '31.75' })],
      )[0]?.suggestedKind,
    ).toBe('add_expense');
  });
});
