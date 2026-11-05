import { describe, expect, it } from 'vitest';
import { transactionDisplayDate } from './transaction-date';

describe('transactionDisplayDate', () => {
  it('does not present a synthetic occurrence day as an unknown purchase date', () => {
    expect(
      transactionDisplayDate({
        domainType: 'credit_card_expense',
        date: '2026-07-01',
        purchaseDate: null,
      }),
    ).toBeNull();
    expect(
      transactionDisplayDate({
        domainType: 'credit_card_refund',
        date: '2026-07-01',
        purchaseDate: '2026-06-20',
      }),
    ).toBe('2026-06-20');
  });
  it('keeps installment occurrence and bank movement dates distinct from the purchase', () => {
    expect(
      transactionDisplayDate({
        domainType: 'credit_card_installment',
        date: '2026-07-01',
        purchaseDate: '2026-04-20',
      }),
    ).toBe('2026-07-01');
    expect(
      transactionDisplayDate({
        domainType: 'bill_payment',
        date: '2026-08-08',
        purchaseDate: null,
      }),
    ).toBe('2026-08-08');
  });
});
