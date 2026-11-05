import { describe, expect, it } from 'vitest';
import { addMonths, getCurrentPeriod } from './date-utils.ts';

describe('addMonths', () => {
  it('adds months within the same year', () => {
    expect(addMonths(1, 2026, 3)).toEqual({ month: 4, year: 2026 });
  });

  it('wraps to next year', () => {
    expect(addMonths(11, 2026, 3)).toEqual({ month: 2, year: 2027 });
  });

  it('handles zero count', () => {
    expect(addMonths(6, 2026, 0)).toEqual({ month: 6, year: 2026 });
  });

  it('handles December to January', () => {
    expect(addMonths(12, 2026, 1)).toEqual({ month: 1, year: 2027 });
  });

  it('handles large positive count', () => {
    expect(addMonths(1, 2026, 24)).toEqual({ month: 1, year: 2028 });
  });

  it('wraps to previous year with -1', () => {
    expect(addMonths(1, 2026, -1)).toEqual({ month: 12, year: 2025 });
  });

  it('wraps multiple years backward', () => {
    expect(addMonths(1, 2026, -13)).toEqual({ month: 12, year: 2024 });
  });

  it('subtracts 6 months from June to December prior year', () => {
    expect(addMonths(6, 2026, -6)).toEqual({ month: 12, year: 2025 });
  });
});

describe('getCurrentPeriod', () => {
  it('returns current month and year', () => {
    const now = new Date();
    const period = getCurrentPeriod();
    expect(period.month).toBe(now.getMonth() + 1);
    expect(period.year).toBe(now.getFullYear());
  });
});
