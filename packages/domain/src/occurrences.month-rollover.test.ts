import { describe, expect, it } from 'vitest';
import { computeOccurrenceDates } from './materializer.ts';

describe('computeOccurrenceDates — year rollover (Dec→Jan)', () => {
  it('produces Dec 2025, Jan, Feb, Mar 2026 with day=15 for monthly horizon 4', () => {
    // Horizon must include the 4th month; impl uses `< horizonEnd` so 4 months
    // yields occurrences at offsets 0..3 (Dec, Jan, Feb, Mar) — the 4th is at
    // exactly horizonEnd and is excluded. We use horizon=4 and expect 4.
    const dates = computeOccurrenceDates({
      frequency: 'monthly',
      startDate: new Date(2025, 11, 15),
      dueDay: 15,
      totalOccurrences: null,
      startingOccurrence: 1,
      horizonMonths: 4,
    });

    expect(dates).toHaveLength(4);
    expect(dates[0].date).toEqual(new Date(2025, 11, 15));
    expect(dates[1].date).toEqual(new Date(2026, 0, 15));
    expect(dates[2].date).toEqual(new Date(2026, 1, 15));
    expect(dates[3].date).toEqual(new Date(2026, 2, 15));
    for (const d of dates) {
      expect(d.date.getDate()).toBe(15);
    }
  });
});
