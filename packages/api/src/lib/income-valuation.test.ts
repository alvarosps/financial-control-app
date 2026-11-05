import { describe, expect, it } from 'vitest';
import { incomeEconomicBrl } from './income-valuation.ts';

describe('incomeEconomicBrl', () => {
  const income = {
    amount: '1000.00',
    currency: 'USD',
    isPaid: false,
    cashAmount: null,
    settlementSource: 'legacy' as const,
    exchangeRate: null,
  };
  it('reports an unavailable consolidation without a rate', () => {
    expect(incomeEconomicBrl(income, null, null)).toBeNull();
  });
  it('uses realized cash for settled forex rather than converting it again', () => {
    expect(
      incomeEconomicBrl(
        { ...income, isPaid: true, cashAmount: '5100.00', settlementSource: 'manual' },
        { exchangeRate: '7', conversionFeePercent: '10' },
        null,
      ),
    ).toBe('5100.00');
  });
  it('preserves payroll gross in the budget and converts a forecast only once', () => {
    expect(
      incomeEconomicBrl(
        { ...income, isPaid: true, cashAmount: '4000.00', settlementSource: 'payroll' },
        { exchangeRate: '7' },
        '5000.00',
      ),
    ).toBe('5000.00');
    expect(incomeEconomicBrl(income, { exchangeRate: '5', conversionFeePercent: '1' }, null)).toBe(
      '4950.00',
    );
    expect(
      incomeEconomicBrl(
        {
          ...income,
          amount: '10000.00',
          currency: 'BRL',
          isPaid: true,
          cashAmount: '9000.00',
          settlementSource: 'payroll',
        },
        null,
        '10000.00',
      ),
    ).toBe('10000.00');
  });
});
