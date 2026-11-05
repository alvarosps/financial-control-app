/**
 * Pure date helpers for the demo seed.
 *
 * The dataset (./demo/dataset.ts) expresses time as `monthsAgo` offsets
 * relative to the current month (0 = current, -14 = 15 months ago). These
 * helpers turn those relative offsets into concrete local-calendar dates at
 * runtime, matching how the app's services construct schedule dates
 * (`new Date(year, month - 1, day)` — local midnight).
 */

export type YearMonth = { year: number; month: number };

/** Calendar (year, month 1-12) at `reference` shifted by `monthsOffset` months. */
export function monthAt(reference: Date, monthsOffset: number): YearMonth {
  const ordinal = reference.getFullYear() * 12 + reference.getMonth() + monthsOffset;
  return { year: Math.floor(ordinal / 12), month: (ordinal % 12) + 1 };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Local-midnight date at (`reference` + `monthsOffset`) on `day`, clamped to
 * [1, last day of that month] — e.g. day 31 in February resolves to Feb 28/29.
 */
export function dateAt(reference: Date, monthsOffset: number, day: number): Date {
  const { year, month } = monthAt(reference, monthsOffset);
  const clamped = Math.min(Math.max(day, 1), daysInMonth(year, month));
  return new Date(year, month - 1, clamped);
}

/** Local midnight of the reference's calendar day. */
export function startOfDay(reference: Date): Date {
  return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
}

/**
 * YYYY-MM-DD key from a DB `date`-mode value. Uses UTC parts because Drizzle
 * deserializes `date` columns as UTC-midnight Dates (same convention as the
 * app's `toIsoDate` helpers in income/loan services).
 */
export function isoDateKey(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
