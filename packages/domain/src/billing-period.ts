import type { StatementDateSource } from '@fc/shared';

export type { StatementDateSource } from '@fc/shared';

export function assignBillingPeriod(
  transactionDate: Date,
  closingDay: number,
): { billingMonth: number; billingYear: number } {
  const day = transactionDate.getDate();
  const month = transactionDate.getMonth() + 1;
  const year = transactionDate.getFullYear();

  if (day <= closingDay) {
    return { billingMonth: month, billingYear: year };
  }

  if (month === 12) {
    return { billingMonth: 1, billingYear: year + 1 };
  }
  return { billingMonth: month + 1, billingYear: year };
}

/**
 * Resolves the billing period for a materialized schedule occurrence — the single
 * source of truth shared by MaterializerService and the standalone run-materializer
 * script.
 *
 * Credit-card INSTALLMENTS use index-based assignment from the schedule's
 * firstBillingMonth/Year: a parcela's bill is its position in the series, not a
 * function of the (cosmetic, due-day-derived) occurrence date. All other
 * credit-card charges fall back to date-based assignment via the card's closing
 * day. Non-credit-card destinations have no billing period.
 *
 * Keeping this in one place prevents the two materializers from disagreeing on
 * which bill an installment belongs to (which happens whenever dueDay > closingDay
 * if one tool uses date-based and the other index-based assignment) — a divergence
 * that also breaks content-key de-duplication of manual reconciliation rows.
 */
export function assignOccurrenceBilling(params: {
  isCreditCard: boolean;
  totalOccurrences: number | null;
  firstBillingMonth: number | null;
  firstBillingYear: number | null;
  occurrenceNumber: number;
  date: Date;
  closingDay: number | null;
}): { billingMonth: number; billingYear: number } | null {
  if (
    params.isCreditCard &&
    params.firstBillingMonth !== null &&
    params.firstBillingYear !== null
  ) {
    const ord =
      params.firstBillingYear * 12 + (params.firstBillingMonth - 1) + (params.occurrenceNumber - 1);
    return { billingMonth: (ord % 12) + 1, billingYear: Math.floor(ord / 12) };
  }
  if (params.closingDay !== null) {
    return assignBillingPeriod(params.date, params.closingDay);
  }
  return null;
}

function clampDay(year: number, monthZeroBased: number, day: number): Date {
  const lastDay = new Date(year, monthZeroBased + 1, 0).getDate();
  return new Date(year, monthZeroBased, Math.min(day, lastDay));
}

/**
 * Resolves the real-calendar DUE date of a fatura from its (closing-month)
 * billing period. `billingMonth` is the month the fatura CLOSES
 * (`assignBillingPeriod`). The due date follows:
 *
 *   if `dueDay <= closingDay` → the fatura is DUE in the calendar month AFTER
 *   `billingMonth`; otherwise it is due in the same month as `billingMonth`.
 *
 * Examples: close 28 / due 3, billingMonth June → July 3; close 3 / due 13 →
 * June 13 (same month). This is a READ-SIDE concern only — it does not affect
 * billing-period assignment or any materialized data.
 *
 * `clampDay` handles both short months (e.g. due 31 in February → Feb 28/29)
 * and the December→January year rollover (monthZeroBased can reach 12, which a
 * JS `Date` rolls forward into the following January).
 */
export function computeFaturaDueDate(
  billingMonth: number,
  billingYear: number,
  dueDay: number,
  closingDay: number,
): Date {
  const monthsOffset = dueDay <= closingDay ? 1 : 0;
  return clampDay(billingYear, billingMonth - 1 + monthsOffset, dueDay);
}

export function getBillingPeriodDateRange(
  billingMonth: number,
  billingYear: number,
  closingDay: number,
): { start: Date; end: Date; bestShoppingDay: Date } {
  // End = closing day of billing month (clamped to actual month length)
  const end = clampDay(billingYear, billingMonth - 1, closingDay);

  // Start = day after closing of PREVIOUS month
  let prevMonth = billingMonth - 1;
  let prevYear = billingYear;
  if (prevMonth === 0) {
    prevMonth = 12;
    prevYear = billingYear - 1;
  }
  const prevClosing = clampDay(prevYear, prevMonth - 1, closingDay);
  const start = new Date(prevClosing);
  start.setDate(start.getDate() + 1);

  const bestShoppingDay = new Date(start);

  return { start, end, bestShoppingDay };
}

export type StatementCycle = {
  billingMonth: number;
  billingYear: number;
  closingDate: string | null;
  dueDate: string | null;
  closingDateSource: StatementDateSource;
  dueDateSource: StatementDateSource;
  confidence: 'confirmed' | 'estimated' | 'unknown';
  reason: 'actual_dates' | 'actual_closing' | 'configuration' | 'missing_dates';
};

export class StatementCycleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'StatementCycleError';
  }
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function calendarDay(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

/** Calendar-only resolution: the canonical period is always the closing month. */
export function resolveStatementCycle(input: {
  reference: 'closing' | 'due';
  month: number;
  year: number;
  closingDate?: string | null;
  dueDate?: string | null;
  closingDateSource?: 'institution' | 'user';
  dueDateSource?: 'institution' | 'user';
  config?: { closingDay: number | null; dueDay: number | null } | null;
}): StatementCycle {
  if (
    !Number.isInteger(input.month) ||
    input.month < 1 ||
    input.month > 12 ||
    !Number.isInteger(input.year) ||
    input.year < 1000 ||
    input.year > 9998
  )
    throw new StatementCycleError('statement.invalidPeriod');
  for (const date of [input.closingDate, input.dueDate])
    if (date != null && !isCalendarDate(date))
      throw new StatementCycleError('statement.invalidDate');
  for (const day of [input.config?.closingDay, input.config?.dueDay])
    if (day != null && (!Number.isInteger(day) || day < 1 || day > 31))
      throw new StatementCycleError('statement.invalidConfig');

  const referencePeriod = `${input.year}-${String(input.month).padStart(2, '0')}`;
  const referenceDate = input.reference === 'closing' ? input.closingDate : input.dueDate;
  if (referenceDate && !referenceDate.startsWith(`${referencePeriod}-`))
    throw new StatementCycleError('statement.cycleConflict');

  let billingMonth = input.month;
  let billingYear = input.year;
  const closingDay = input.config?.closingDay;
  const dueDay = input.config?.dueDay;
  if (input.closingDate) {
    [billingYear, billingMonth] = input.closingDate.split('-').map(Number);
  } else if (input.reference === 'due') {
    if (closingDay == null || dueDay == null)
      throw new StatementCycleError('statement.insufficientCycleData');
    const ordinal = input.year * 12 + input.month - 1 - (dueDay <= closingDay ? 1 : 0);
    billingMonth = (ordinal % 12) + 1;
    billingYear = Math.floor(ordinal / 12);
  }

  let closingDate =
    input.closingDate ??
    (closingDay == null ? null : calendarDay(billingYear, billingMonth, closingDay));
  const effectiveClosingDay = input.closingDate
    ? Number(input.closingDate.slice(8, 10))
    : closingDay;
  const dueDate =
    input.dueDate ??
    (effectiveClosingDay == null || dueDay == null
      ? null
      : calendarDay(billingYear, billingMonth + (dueDay <= effectiveClosingDay ? 1 : 0), dueDay));
  if (closingDate && dueDate && dueDate < closingDate) {
    if (input.closingDate) throw new StatementCycleError('statement.cycleConflict');
    // Current settings cannot invalidate an institution's known due date.
    closingDate = null;
  }
  if (input.reference === 'due' && dueDate && !dueDate.startsWith(`${referencePeriod}-`))
    throw new StatementCycleError('statement.cycleConflict');

  return {
    billingMonth,
    billingYear,
    closingDate,
    dueDate,
    closingDateSource: input.closingDate
      ? (input.closingDateSource ?? 'institution')
      : closingDate
        ? 'configuration'
        : 'unknown',
    dueDateSource: input.dueDate
      ? (input.dueDateSource ?? 'institution')
      : dueDate
        ? 'configuration'
        : 'unknown',
    confidence:
      input.closingDate && input.dueDate
        ? 'confirmed'
        : closingDate && dueDate
          ? 'estimated'
          : 'unknown',
    reason:
      input.closingDate && input.dueDate
        ? 'actual_dates'
        : input.closingDate
          ? 'actual_closing'
          : closingDate || dueDate
            ? 'configuration'
            : 'missing_dates',
  };
}
