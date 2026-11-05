/**
 * Local-calendar date helpers shared by the dashboard and month-overview
 * services. The `transactions.date` column is UTC-midnight, but the upcoming /
 * planner windows are reasoned about in LOCAL calendar days (a fatura "due on
 * the 10th" must compare against the user's local 10th). Building everything
 * from local date parts keeps both sides consistent and avoids the UTC
 * off-by-one a bare `new Date(iso)` would introduce in UTC−3.
 */

/** YYYY-MM-DD from LOCAL date parts (avoids the UTC off-by-one). */
export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parse a YYYY-MM-DD calendar-date string into a LOCAL-midnight Date so it can
 * be compared against window bounds built from local date parts. Avoids the UTC
 * off-by-one a bare `new Date(iso)` would cause.
 */
export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Inclusive local-day window `[today, today+days]` anchored at `asOf`. `today`
 * is `asOf` truncated to local midnight; `future` is `days` later. Also returns
 * an `inWindow` predicate so callers compare local-midnight dates uniformly.
 */
export function localDayWindow(
  asOf: Date,
  days: number,
): { today: Date; future: Date; inWindow: (d: Date) => boolean } {
  const today = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  const future = new Date(today);
  future.setDate(future.getDate() + days);
  return { today, future, inWindow: (d: Date) => d >= today && d <= future };
}

/**
 * Every calendar month (1-based) the local-day window `[asOf, asOf+days]`
 * spans, in chronological order from the window start through the window end
 * inclusive. Built from the SAME `localDayWindow(asOf, days)` the per-item
 * filters use, so monthly recurring items (loans, fixed charges) and the income
 * that offsets them are loaded for every month a due date can fall in — not just
 * the month of `asOf`. Handles the Dec→Jan year rollover.
 */
export function monthsInLocalWindow(
  asOf: Date,
  days: number,
): Array<{ month: number; year: number }> {
  const { today, future } = localDayWindow(asOf, days);
  const result: Array<{ month: number; year: number }> = [];
  let y = today.getFullYear();
  let m = today.getMonth(); // 0-based cursor
  const endY = future.getFullYear();
  const endM = future.getMonth();
  while (y < endY || (y === endY && m <= endM)) {
    result.push({ month: m + 1, year: y });
    if (m === 11) {
      m = 0;
      y += 1;
    } else {
      m += 1;
    }
  }
  return result;
}
