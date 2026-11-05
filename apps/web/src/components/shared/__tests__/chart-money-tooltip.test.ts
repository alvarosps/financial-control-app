import { describe, expect, it } from 'vitest';
import { formatTooltipMoney } from '@/components/shared/chart-money-tooltip';

describe('formatTooltipMoney', () => {
  it('formats numbers as BRL currency', () => {
    expect(formatTooltipMoney(1234.5)).toBe('R$ 1.234,50');
  });

  it('renders an em dash for null/undefined', () => {
    expect(formatTooltipMoney(null)).toBe('—');
    expect(formatTooltipMoney(undefined)).toBe('—');
  });

  it('stringifies non-numeric values', () => {
    expect(formatTooltipMoney('abc')).toBe('abc');
  });
});
