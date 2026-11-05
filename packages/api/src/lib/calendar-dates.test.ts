import { describe, expect, it } from 'vitest';
import { monthsInLocalWindow } from './calendar-dates.ts';

describe('monthsInLocalWindow', () => {
  it('returns a single month when the window stays inside one calendar month', () => {
    // 2026-06-10, 5-day window → reaches 2026-06-15: only June.
    const months = monthsInLocalWindow(new Date(2026, 5, 10), 5);
    expect(months).toEqual([{ month: 6, year: 2026 }]);
  });

  it('spans two months when the window crosses a month boundary', () => {
    // 2026-06-25, 30-day window → reaches 2026-07-25: June and July.
    const months = monthsInLocalWindow(new Date(2026, 5, 25), 30);
    expect(months).toEqual([
      { month: 6, year: 2026 },
      { month: 7, year: 2026 },
    ]);
  });

  it('spans three months for a 45-day window reaching a third month', () => {
    // 2026-01-20, 45-day window → reaches ≈2026-03-06: January, February, March.
    const months = monthsInLocalWindow(new Date(2026, 0, 20), 45);
    expect(months).toEqual([
      { month: 1, year: 2026 },
      { month: 2, year: 2026 },
      { month: 3, year: 2026 },
    ]);
  });

  it('handles the Dec→Jan year rollover', () => {
    // 2026-12-20, 30-day window → reaches 2027-01-19: Dec 2026 and Jan 2027.
    const months = monthsInLocalWindow(new Date(2026, 11, 20), 30);
    expect(months).toEqual([
      { month: 12, year: 2026 },
      { month: 1, year: 2027 },
    ]);
  });
});
