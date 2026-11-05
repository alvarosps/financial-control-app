import { describe, expect, it } from 'vitest';
import { calculateAverageIncome } from '@/components/dashboard/CashFlowChart';

describe('calculateAverageIncome', () => {
  it('averages only months that have income', () => {
    expect(
      calculateAverageIncome([
        { income: 2_000, expenses: 400, name: 'jan/26' },
        { income: 0, expenses: 700, name: 'fev/26' },
        { income: 4_000, expenses: 300, name: 'mar/26' },
      ]),
    ).toBe(3_000);
  });

  it('returns zero when no month has income', () => {
    expect(
      calculateAverageIncome([
        { income: 0, expenses: 400, name: 'jan/26' },
        { income: 0, expenses: 700, name: 'fev/26' },
      ]),
    ).toBe(0);
  });
});
