import { describe, expect, it } from 'vitest';
import { frequencyToMonthly } from '../frequency';

describe('frequencyToMonthly', () => {
  it('monthly → 1', () => {
    expect(frequencyToMonthly('monthly')).toBe(1);
  });

  it('weekly → 4', () => {
    expect(frequencyToMonthly('weekly')).toBe(4);
  });

  it('biweekly → 2', () => {
    expect(frequencyToMonthly('biweekly')).toBe(2);
  });

  it('bimonthly → 0.5', () => {
    expect(frequencyToMonthly('bimonthly')).toBeCloseTo(0.5);
  });

  it('quarterly → 1/3', () => {
    expect(frequencyToMonthly('quarterly')).toBeCloseTo(1 / 3);
  });

  it('semiannual → 1/6', () => {
    expect(frequencyToMonthly('semiannual')).toBeCloseTo(1 / 6);
  });

  it('annual → 1/12', () => {
    expect(frequencyToMonthly('annual')).toBeCloseTo(1 / 12);
  });

  it('once → 0 (excluded from monthly totals)', () => {
    expect(frequencyToMonthly('once')).toBe(0);
  });
});
