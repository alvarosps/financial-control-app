import { describe, expect, it } from 'vitest';
import { computeOccurrenceDates } from './materializer.ts';

describe('computeOccurrenceDates — leap year clamping', () => {
  it('clamps Feb 29 (leap) to Feb 28 in the following non-leap year', () => {
    // impl uses LOCAL Date construction (new Date(y, m, d)), so we match.
    const dates = computeOccurrenceDates({
      frequency: 'monthly',
      startDate: new Date(2024, 1, 29), // 29 Feb 2024 (leap)
      dueDay: 29,
      totalOccurrences: null,
      startingOccurrence: 1,
      horizonMonths: 13,
    });

    // Find occurrence in Feb 2025 (month index 1, year 2025)
    const feb2025 = dates.find((d) => d.date.getFullYear() === 2025 && d.date.getMonth() === 1);
    expect(feb2025).toBeDefined();
    expect(feb2025?.date.getDate()).toBe(28);

    // Sanity: Feb 2024 original day should be 29
    const feb2024 = dates.find((d) => d.date.getFullYear() === 2024 && d.date.getMonth() === 1);
    expect(feb2024?.date.getDate()).toBe(29);
  });
});
