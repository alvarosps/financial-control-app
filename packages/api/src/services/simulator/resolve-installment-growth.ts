import type { DbExecutor } from '@fc/db';
import type { LeverEvent, ResolvedDelta } from '@fc/domain';
import { Money } from '@fc/domain';
import { monthIndex, type SimLever } from '@fc/shared';
import {
  addToMonthMap,
  isMonthOnOrAfter,
  type ResolveContext,
  toByMonth,
} from './resolve-lever.ts';

type InstallmentGrowthLever = Extract<SimLever, { kind: 'installment_growth' }>;

/**
 * Accumulating installment burden. Starting at `fromMonth`, a NEW installment of
 * `monthlyAmount` begins each month. With `k = monthIndex(m) −
 * monthIndex(fromMonth) + 1`:
 *  - **No `termMonths`:** every installment runs to the horizon end, so month `m`
 *    carries `monthlyAmount × k` (perpetual linear growth — original behavior).
 *  - **`termMonths = T`:** each installment lives `T` months, so the count of
 *    still-active installments at month `m` is `min(k, T)` — the burden grows for
 *    `T` months then holds steady at `monthlyAmount × T` (rolling window: the
 *    installment started `T` months ago drops off as a new one begins).
 *
 * AMOUNT-DRIVEN: the burden is derived purely from `lever.monthlyAmount`,
 * `lever.termMonths` and the calendar distance from `fromMonth`; income is
 * untouched and a single annotation event marks `fromMonth`. Reads no user data
 * (`_db`/`_userId` unused) → no IDOR surface.
 */
export function resolveInstallmentGrowth(
  _db: DbExecutor,
  _userId: string,
  lever: InstallmentGrowthLever,
  ctx: ResolveContext,
): ResolvedDelta {
  const monthly = Money.fromString(lever.monthlyAmount, 'BRL');
  const term = lever.termMonths;
  const map = new Map<string, { income: Money; expense: Money }>();
  for (const m of ctx.months) {
    if (!isMonthOnOrAfter(m, lever.fromMonth)) continue;
    const k = monthIndex(m) - monthIndex(lever.fromMonth) + 1;
    const active = term !== undefined ? Math.min(k, term) : k;
    addToMonthMap(map, m, 'expense', monthly.multiply(active));
  }
  const events: LeverEvent[] = [
    {
      month: lever.fromMonth.month,
      year: lever.fromMonth.year,
      label: lever.label,
      sign: 'outflow',
      amount: lever.monthlyAmount,
    },
  ];
  return { leverId: lever.id, byMonth: toByMonth(ctx.months, map), events };
}
