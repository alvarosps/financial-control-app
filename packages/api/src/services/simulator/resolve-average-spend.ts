import type { DbExecutor } from '@fc/db';
import type { ResolvedDelta } from '@fc/domain';
import { Money } from '@fc/domain';
import type { SimLever } from '@fc/shared';
import {
  addToMonthMap,
  isMonthOnOrAfter,
  type ResolveContext,
  toByMonth,
} from './resolve-lever.ts';

type AverageSpendLever = Extract<SimLever, { kind: 'average_spend' }>;

/**
 * Flat additive monthly expense from `fromMonth` to the horizon end. Models the
 * variable/discretionary spend layer the baseline projection does not schedule.
 *
 * AMOUNT-DRIVEN: every month on/after `fromMonth` gets `lever.amount` added to
 * its expense delta; income is untouched and the lever surfaces no events. The
 * resolver reads no user data (`_db`/`_userId` unused) → no IDOR surface.
 */
export function resolveAverageSpend(
  _db: DbExecutor,
  _userId: string,
  lever: AverageSpendLever,
  ctx: ResolveContext,
): ResolvedDelta {
  const amount = Money.fromString(lever.amount, 'BRL');
  const map = new Map<string, { income: Money; expense: Money }>();
  for (const m of ctx.months) {
    if (isMonthOnOrAfter(m, lever.fromMonth)) addToMonthMap(map, m, 'expense', amount);
  }
  return { leverId: lever.id, byMonth: toByMonth(ctx.months, map), events: [] };
}
