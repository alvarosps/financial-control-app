import type { DbExecutor } from '@fc/db';
import type { LeverEvent, MonthDelta, ResolvedDelta } from '@fc/domain';
import { computeOccurrenceDates, Money } from '@fc/domain';
import type { SimLever } from '@fc/shared';
import {
  addToMonthMap,
  isInMonth,
  monthRefToDate,
  occurrenceHorizonMonths,
  type ResolveContext,
  toByMonth,
} from './resolve-lever.ts';

type IncomeChangeLever = Extract<SimLever, { kind: 'income_change' }>;

/**
 * Resolve an income change into per-month income deltas. The lever is
 * AMOUNT-DRIVEN: every op operates on the lever's own `amount` field, not on
 * the user's real baseline income (the resolver context carries no baseline,
 * so there is nothing to read from here — see the plan's Task 11 notes).
 *
 *  - `add`: a positive recurring income placed on its real occurrence months
 *    (`computeOccurrenceDates`), from `fromMonth` (optionally bounded by `toMonth`).
 *  - `adjust`: same placement, but the contribution is `amount * (percent/100)` —
 *    a signed delta (positive percent raises income, negative lowers it). The
 *    caller supplies the amount the percent applies to; nothing baseline is read.
 *  - `end`: a NEGATIVE recurring income from `fromMonth` (the ended income leaves);
 *    the magnitude is the caller-supplied `amount`.
 * The simulator is BRL-only in v1: lever amounts are stored as BRL money strings
 * and used directly — no FX conversion happens here.
 */
export async function resolveIncomeChange(
  _db: DbExecutor,
  _userId: string,
  lever: IncomeChangeLever,
  ctx: ResolveContext,
): Promise<ResolvedDelta> {
  const currency = 'BRL'; // lever amounts are stored as BRL money strings in v1
  const baseAmount =
    lever.amount !== undefined ? Money.fromString(lever.amount, currency) : Money.zero('BRL');

  // Per-month contribution after op semantics. BRL throughout (simulator is
  // BRL-only in v1), so the lever amount is used as-is — no FX conversion.
  let perOccurrence: Money;
  if (lever.op === 'adjust') {
    const pct = lever.percent ?? 0;
    perOccurrence = baseAmount.multiply(pct / 100);
  } else if (lever.op === 'end') {
    perOccurrence = baseAmount.negate();
  } else {
    perOccurrence = baseAmount;
  }

  const startDate = monthRefToDate(lever.fromMonth);
  const endDate =
    lever.toMonth !== undefined
      ? new Date(lever.toMonth.year, lever.toMonth.month, 0) // last day of toMonth
      : undefined;

  const occurrences = computeOccurrenceDates({
    frequency: lever.frequency,
    startDate,
    dueDay: 1,
    totalOccurrences: null,
    startingOccurrence: 1,
    horizonMonths: occurrenceHorizonMonths(startDate, ctx),
    endDate,
  });

  const accumulator = new Map<string, { income: Money; expense: Money }>();
  for (const occ of occurrences) {
    const ref = ctx.months.find((m) => isInMonth(occ.date, m));
    if (!ref) continue;
    addToMonthMap(accumulator, ref, 'income', perOccurrence);
  }

  const byMonth: MonthDelta[] = toByMonth(ctx.months, accumulator);
  const events: LeverEvent[] = [];
  return { leverId: lever.id, byMonth, events };
}
