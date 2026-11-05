import { describe, expect, it } from 'vitest';
import { computeOccurrenceDates } from './materializer.ts';

describe('computeOccurrenceDates — 36-installment plan', () => {
  it('generates all 36 monthly occurrences; index 23 is parcela 24/36', () => {
    const startDate = new Date(2025, 0, 10); // Jan 10, 2025
    const dates = computeOccurrenceDates({
      frequency: 'monthly',
      startDate,
      dueDay: 10,
      totalOccurrences: 36,
      startingOccurrence: 1,
      horizonMonths: 40,
    });

    expect(dates).toHaveLength(36);
    expect(dates[0].occurrenceNumber).toBe(1);
    expect(dates[0].date).toEqual(new Date(2025, 0, 10));

    // Parcela 24/36 — 23 months after Jan 2025 = Dec 2026
    const p24 = dates[23];
    expect(p24.occurrenceNumber).toBe(24);
    expect(p24.date).toEqual(new Date(2026, 11, 10));

    // Final (36/36) — 35 months after = Dec 2027
    const last = dates[35];
    expect(last.occurrenceNumber).toBe(36);
    expect(last.date).toEqual(new Date(2027, 11, 10));
  });
});
