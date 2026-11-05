import type { DbExecutor } from '@fc/db';
import type { MonthDelta, ResolvedDelta } from '@fc/domain';
import { Money } from '@fc/domain';
import { type MonthRef, monthIndex, type SimLever } from '@fc/shared';
import { resolveAverageSpend } from './resolve-average-spend.ts';
import { resolveIncomeChange } from './resolve-income-change.ts';
import { resolveInstallmentGrowth } from './resolve-installment-growth.ts';
import { resolveInstallmentPlan } from './resolve-installment-plan.ts';
import { resolveLoanPayoff } from './resolve-loan-payoff.ts';
import { resolveOneTimeEvent } from './resolve-one-time-event.ts';
import { resolveRecurringChange } from './resolve-recurring-change.ts';

export type ResolveContext = {
  /** Ordered list of the projection's months (index 0 = current month). */
  months: MonthRef[];
  horizon: number;
  asOf: Date;
};

/** Zero income/expense delta for a month — building block for resolvers. */
export function emptyMonthDelta(ref: MonthRef): MonthDelta {
  return { month: ref.month, year: ref.year, incomeDelta: '0.00', expenseDelta: '0.00' };
}

/** True when a placed date falls in the same calendar month as `ref`. */
export function isInMonth(date: Date, ref: MonthRef): boolean {
  return date.getFullYear() === ref.year && date.getMonth() + 1 === ref.month;
}

/** True when month `a` is on/after month `b` (calendar order). */
export function isMonthOnOrAfter(a: MonthRef, b: MonthRef): boolean {
  return monthIndex(a) >= monthIndex(b);
}

/** First day of a MonthRef as a Date (local midnight). */
export function monthRefToDate(ref: MonthRef, day = 1): Date {
  return new Date(ref.year, ref.month - 1, day);
}

/**
 * Size the `horizonMonths` passed to `computeOccurrenceDates` so its generation
 * window — anchored at `startDate`, not at the projection start — reaches the
 * projection's LAST month.
 *
 * `computeOccurrenceDates` builds `horizonEnd = startDate + horizonMonths` and
 * keeps occurrences strictly BEFORE it (`date < horizonEnd`, exclusive end). If
 * `startDate` precedes the projection's first month (a backdated `fromMonth`, or
 * a real schedule whose `startDate` is in the past), a window sized from the
 * projection start (e.g. `ctx.horizon + 1`) ends before the projection horizon,
 * so in-window months would get NO occurrence and the lever would silently do
 * nothing.
 *
 * The window must span from `startDate`'s month to the last projection month,
 * inclusive. With `delta = monthIndex(last) - monthIndex(startMonth)`:
 *  - `delta + 1` lands `horizonEnd` on the FIRST day of the month AFTER the last
 *    projection month, so every occurrence date inside the last projection month
 *    (any due-day) is strictly before it → the last month is fully included.
 *  - the extra `+1` (→ `delta + 2`) is a safety margin against the exclusive end;
 *    it only ever generates one further month, which is filtered out downstream
 *    by `ctx.months.find`, so it is harmless.
 *
 * Clamped `>= 1` so a degenerate same-month span still generates. Over-generation
 * is bounded by the schedule's finite caps (`totalOccurrences` / `endDate`).
 */
export function occurrenceHorizonMonths(startDate: Date, ctx: ResolveContext): number {
  const lastWindow = ctx.months[ctx.months.length - 1];
  const startRef: MonthRef = { month: startDate.getMonth() + 1, year: startDate.getFullYear() };
  return Math.max(1, monthIndex(lastWindow) - monthIndex(startRef) + 2);
}

/**
 * Accumulate a signed BRL delta into the per-month map keyed by `year-month`.
 * `bucket` decides whether it lands on income or expense.
 */
export function addToMonthMap(
  map: Map<string, { income: Money; expense: Money }>,
  ref: MonthRef,
  bucket: 'income' | 'expense',
  amount: Money,
): void {
  const key = `${ref.year}-${ref.month}`;
  const entry = map.get(key) ?? { income: Money.zero('BRL'), expense: Money.zero('BRL') };
  if (bucket === 'income') entry.income = entry.income.add(amount);
  else entry.expense = entry.expense.add(amount);
  map.set(key, entry);
}

/** Materialize the accumulator map into the ordered byMonth list (every month present). */
export function toByMonth(
  months: MonthRef[],
  map: Map<string, { income: Money; expense: Money }>,
): MonthDelta[] {
  return months.map((ref) => {
    const entry = map.get(`${ref.year}-${ref.month}`);
    return {
      month: ref.month,
      year: ref.year,
      incomeDelta: (entry?.income ?? Money.zero('BRL')).toDbString(),
      expenseDelta: (entry?.expense ?? Money.zero('BRL')).toDbString(),
    };
  });
}

/**
 * Resolve a single lever into a per-month signed delta + display events.
 * DB-bound only for lookups (loan schedule, schedule row, FX rate); the
 * placement math (computeOccurrenceDates, payoff.ts) is pure domain.
 *
 * Each `kind` is implemented in a sibling resolver file and wired here.
 */
export async function resolveLever(
  db: DbExecutor,
  userId: string,
  lever: SimLever,
  ctx: ResolveContext,
): Promise<ResolvedDelta> {
  switch (lever.kind) {
    case 'loan_payoff':
      return resolveLoanPayoff(db, userId, lever, ctx);
    case 'income_change':
      return resolveIncomeChange(db, userId, lever, ctx);
    case 'one_time_event':
      return resolveOneTimeEvent(db, userId, lever, ctx);
    case 'recurring_change':
      return resolveRecurringChange(db, userId, lever, ctx);
    case 'savings_goal': {
      // Analysis-only in v1: no projection delta, surfaced as a KPI later.
      const byMonth: MonthDelta[] = ctx.months.map(emptyMonthDelta);
      return { leverId: lever.id, byMonth, events: [] };
    }
    case 'average_spend':
      return resolveAverageSpend(db, userId, lever, ctx);
    case 'installment_growth':
      return resolveInstallmentGrowth(db, userId, lever, ctx);
    case 'installment_plan':
      return resolveInstallmentPlan(db, userId, lever, ctx);
    default: {
      // Every SimLever kind is handled above; this guards against an unhandled
      // kind being added later (the assignment fails to compile if so).
      const exhaustive: never = lever;
      throw new Error(`Unhandled lever kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
