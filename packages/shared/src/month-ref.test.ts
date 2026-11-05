import { describe, expect, it } from 'vitest';
import { addMonths, monthIndex } from './month-ref.ts';
import type { MonthRef } from './simulator.ts';

describe('monthIndex', () => {
  it('orders months within a year', () => {
    expect(monthIndex({ month: 1, year: 2026 })).toBeLessThan(
      monthIndex({ month: 12, year: 2026 }),
    );
  });

  it('orders months across a year boundary', () => {
    expect(monthIndex({ month: 12, year: 2026 })).toBeLessThan(
      monthIndex({ month: 1, year: 2027 }),
    );
  });

  it('is equal for the same month', () => {
    expect(monthIndex({ month: 6, year: 2026 })).toBe(monthIndex({ month: 6, year: 2026 }));
  });
});

describe('addMonths', () => {
  it('rolls over forward across a year boundary (Dec 2026 +1 -> Jan 2027)', () => {
    expect(addMonths({ month: 12, year: 2026 }, 1)).toEqual({ month: 1, year: 2027 });
  });

  it('rolls over backward across a year boundary (Jan 2026 -1 -> Dec 2025)', () => {
    expect(addMonths({ month: 1, year: 2026 }, -1)).toEqual({ month: 12, year: 2025 });
  });

  it('returns the same month for +0', () => {
    expect(addMonths({ month: 7, year: 2026 }, 0)).toEqual({ month: 7, year: 2026 });
  });

  it('handles a multi-year forward shift (+13)', () => {
    expect(addMonths({ month: 6, year: 2026 }, 13)).toEqual({ month: 7, year: 2027 });
  });

  it('handles a multi-year backward shift (-13)', () => {
    expect(addMonths({ month: 6, year: 2026 }, -13)).toEqual({ month: 5, year: 2025 });
  });

  it('advances within the same year', () => {
    expect(addMonths({ month: 3, year: 2026 }, 4)).toEqual({ month: 7, year: 2026 });
  });

  it('matches monthIndex distance for an arbitrary shift', () => {
    const start: MonthRef = { month: 9, year: 2026 };
    const shifted = addMonths(start, 5);
    expect(monthIndex(shifted) - monthIndex(start)).toBe(5);
  });
});
