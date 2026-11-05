import { describe, expect, it } from 'vitest';
import { computeOccurrenceDates } from './materializer.ts';

/**
 * What the domain permits for `startingOccurrence`:
 *
 *   `computeOccurrenceDates` treats `startingOccurrence` as the LABEL of the
 *   first generated occurrence. It does NOT shift `startDate`; the caller is
 *   responsible for passing a `startDate` that already corresponds to that
 *   occurrence. `remainingOccurrences` is reduced by `startingOccurrence - 1`
 *   when a finite `totalOccurrences` is provided, so a plan starting at 5 out
 *   of 10 produces 6 dates numbered 5..10.
 *
 * NOTE: `MaterializerService` ENFORCES `startingOccurrence === 1` at a higher
 * layer (separate invariant — see the credit-card rules in CLAUDE.md).
 * `computeOccurrenceDates` itself accepts any positive integer.
 */
describe('computeOccurrenceDates — startingOccurrence semantics (domain permits any)', () => {
  it('labels first occurrence with startingOccurrence and uses startDate as-is', () => {
    const dates = computeOccurrenceDates({
      frequency: 'monthly',
      startDate: new Date(2026, 4, 10), // May 10, 2026
      dueDay: 10,
      totalOccurrences: 10,
      startingOccurrence: 5,
      horizonMonths: 24,
    });

    // remainingOccurrences = 10 - 5 + 1 = 6
    expect(dates).toHaveLength(6);
    expect(dates[0].occurrenceNumber).toBe(5);
    expect(dates[0].date).toEqual(new Date(2026, 4, 10));
    expect(dates[5].occurrenceNumber).toBe(10);
    expect(dates[5].date).toEqual(new Date(2026, 9, 10)); // Oct 10, 2026
  });

  it('with null totalOccurrences, startingOccurrence just shifts the labels', () => {
    const dates = computeOccurrenceDates({
      frequency: 'monthly',
      startDate: new Date(2026, 0, 1),
      dueDay: 1,
      totalOccurrences: null,
      startingOccurrence: 3,
      horizonMonths: 3,
    });

    expect(dates).toHaveLength(3);
    expect(dates.map((d) => d.occurrenceNumber)).toEqual([3, 4, 5]);
  });
});
