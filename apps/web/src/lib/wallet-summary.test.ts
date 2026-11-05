import { describe, expect, it } from 'vitest';
import { walletOverdraft, walletsTotals } from './wallet-summary';

describe('walletOverdraft', () => {
  it('reports zero usage when the balance is positive', () => {
    expect(walletOverdraft(1500, '20000.00')).toEqual({ used: 0, available: 21500 });
  });

  it('reports used overdraft capped at the limit when negative', () => {
    expect(walletOverdraft(-14830.46, '20000.00')).toEqual({
      used: 14830.46,
      available: 5169.54,
    });
  });

  it('treats a null limit as no limit (used = full negative, available = balance)', () => {
    expect(walletOverdraft(-500, null)).toEqual({ used: 500, available: -500 });
  });
});

describe('walletsTotals', () => {
  it('sums cash, overdraft used and available across wallets', () => {
    const totals = walletsTotals([
      { cash: -14830.46, overdraftLimit: '20000.00' },
      { cash: 200, overdraftLimit: null },
    ]);
    expect(totals.cash).toBeCloseTo(-14630.46, 2);
    expect(totals.overdraftUsed).toBeCloseTo(14830.46, 2);
    expect(totals.available).toBeCloseTo(5369.54, 2);
  });
});
