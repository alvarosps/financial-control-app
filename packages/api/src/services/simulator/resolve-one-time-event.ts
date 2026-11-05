import type { DbExecutor } from '@fc/db';
import type { LeverEvent, MonthDelta, ResolvedDelta } from '@fc/domain';
import { Money } from '@fc/domain';
import type { SimLever } from '@fc/shared';
import { addToMonthMap, type ResolveContext, toByMonth } from './resolve-lever.ts';

type OneTimeEventLever = Extract<SimLever, { kind: 'one_time_event' }>;

/**
 * A single signed delta in `month`: inflow → income.lever +, outflow →
 * expenses.lever +. Always BRL (lever amounts are BRL money strings in v1).
 */
export async function resolveOneTimeEvent(
  _db: DbExecutor,
  _userId: string,
  lever: OneTimeEventLever,
  ctx: ResolveContext,
): Promise<ResolvedDelta> {
  const amount = Money.fromString(lever.amount, 'BRL');
  const accumulator = new Map<string, { income: Money; expense: Money }>();
  const events: LeverEvent[] = [];

  const ref = ctx.months.find((m) => m.month === lever.month.month && m.year === lever.month.year);
  if (ref) {
    addToMonthMap(accumulator, ref, lever.sign === 'inflow' ? 'income' : 'expense', amount);
    events.push({
      month: ref.month,
      year: ref.year,
      label: lever.label,
      sign: lever.sign,
      amount: amount.toDbString(),
    });
  }

  const byMonth: MonthDelta[] = toByMonth(ctx.months, accumulator);
  return { leverId: lever.id, byMonth, events };
}
