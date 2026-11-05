import { describe, expect, it } from 'vitest';
import { resolveScheduledAmount } from './scheduled-amount.ts';

describe('resolveScheduledAmount', () => {
  it('keeps the original amount before a reviewed change and applies later changes by cycle', () => {
    const changes = [
      { billingMonth: 2, billingYear: 2027, amount: '35.00' },
      { billingMonth: 12, billingYear: 2026, amount: '30.00' },
    ];
    expect(resolveScheduledAmount('20.00', changes, { billingMonth: 11, billingYear: 2026 })).toBe(
      '20.00',
    );
    expect(resolveScheduledAmount('20.00', changes, { billingMonth: 1, billingYear: 2027 })).toBe(
      '30.00',
    );
    expect(resolveScheduledAmount('20.00', changes, { billingMonth: 2, billingYear: 2027 })).toBe(
      '35.00',
    );
    expect(resolveScheduledAmount('20.00', changes, null)).toBe('20.00');
  });
});
