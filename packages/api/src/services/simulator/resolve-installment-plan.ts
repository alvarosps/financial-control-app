import type { DbExecutor } from '@fc/db';
import type { LeverEvent, ResolvedDelta } from '@fc/domain';
import { Money } from '@fc/domain';
import { monthIndex, type SimLever } from '@fc/shared';
import { addToMonthMap, type ResolveContext, toByMonth } from './resolve-lever.ts';

type InstallmentPlanLever = Extract<SimLever, { kind: 'installment_plan' }>;

/**
 * Finite installment plan. Charges `amount` to each of the N months in the
 * window `[startMonth, startMonth + installments − 1]`. The window is naturally
 * clamped to the projection horizon — only `ctx.months` are iterated, so any
 * parcela that would fall past the horizon end simply never appears.
 *
 * AMOUNT-DRIVEN: the burden is derived purely from `lever.amount`, `startMonth`,
 * and `installments`; income is untouched and a single annotation event marks
 * `startMonth`. Reads no user data (`_db`/`_userId` unused) → no IDOR surface.
 */
export function resolveInstallmentPlan(
  _db: DbExecutor,
  _userId: string,
  lever: InstallmentPlanLever,
  ctx: ResolveContext,
): ResolvedDelta {
  const amount = Money.fromString(lever.amount, 'BRL');
  const startIdx = monthIndex(lever.startMonth);
  const endIdx = startIdx + Math.max(0, lever.installments) - 1;
  const map = new Map<string, { income: Money; expense: Money }>();
  for (const m of ctx.months) {
    const idx = monthIndex(m);
    if (idx < startIdx || idx > endIdx) continue;
    addToMonthMap(map, m, 'expense', amount);
  }
  const events: LeverEvent[] = [
    {
      month: lever.startMonth.month,
      year: lever.startMonth.year,
      label: lever.label,
      sign: 'outflow',
      amount: lever.amount,
    },
  ];
  return { leverId: lever.id, byMonth: toByMonth(ctx.months, map), events };
}
