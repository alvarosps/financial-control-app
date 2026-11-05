import type { DbExecutor } from '@fc/db';
import { incomeSourceConfigs, scheduledTransactions } from '@fc/db';
import type { LeverEvent, MonthDelta, ResolvedDelta } from '@fc/domain';
import { computeOccurrenceDates, Money } from '@fc/domain';
import type { SimLever } from '@fc/shared';
import { and, eq } from 'drizzle-orm';
import { FxRateService } from '../fx-rate.service.ts';
import {
  addToMonthMap,
  isInMonth,
  monthRefToDate,
  occurrenceHorizonMonths,
  type ResolveContext,
  toByMonth,
} from './resolve-lever.ts';

type RecurringChangeLever = Extract<SimLever, { kind: 'recurring_change' }>;

/**
 * `cancel`: resolve the schedule (scoped to the user), place its REAL occurrences
 * (computeOccurrenceDates) on the right months and SUBTRACT them — no flat monthly
 * average. A non-BRL schedule is FX-converted to BRL using the SAME rate source the
 * rest of the app uses (`income_source_configs.exchange_rate` for the schedule's
 * source account — kept fresh by FxRateService — falling back to the global
 * USD→BRL `fx_rates` cache). The simulator is BRL-only in v1, so if NO rate is
 * resolvable the stored `amount` is treated as already-BRL; this NEVER throws.
 *
 * `add`: place a new synthetic recurrence (positive expense) at the given frequency
 * from `startMonth` (optionally bounded by `endMonth`).
 */
export async function resolveRecurringChange(
  db: DbExecutor,
  userId: string,
  lever: RecurringChangeLever,
  ctx: ResolveContext,
): Promise<ResolvedDelta> {
  const accumulator = new Map<string, { income: Money; expense: Money }>();
  const events: LeverEvent[] = [];

  if (lever.op === 'cancel') {
    if (lever.scheduledTransactionId === undefined) {
      const byMonth: MonthDelta[] = toByMonth(ctx.months, accumulator);
      return { leverId: lever.id, byMonth, events };
    }
    const [schedule] = await db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.id, lever.scheduledTransactionId),
          eq(scheduledTransactions.userId, userId),
        ),
      );
    if (schedule) {
      // BRL-normalize the per-occurrence amount. For a non-BRL schedule, resolve
      // the rate the SAME way MonthSummaryService/MonthOverviewService do: the
      // schedule has no per-row rate, so prefer the income source config rate for
      // its source account (FxRateService keeps this in sync with the live
      // USD→BRL rate), falling back to the global fx_rates cache. The simulator is
      // BRL-only in v1: if neither source yields a rate, we treat the stored
      // amount as already-BRL (rate 1:1) so a non-BRL schedule can never
      // hard-500 the run. See normalizeToBrl below.
      const perOccurrence = await normalizeToBrl(
        db,
        schedule.amount,
        schedule.currency,
        schedule.sourceAccountId,
      );
      const startDate =
        typeof schedule.startDate === 'string' ? new Date(schedule.startDate) : schedule.startDate;
      const endDate =
        schedule.endDate == null
          ? undefined
          : typeof schedule.endDate === 'string'
            ? new Date(schedule.endDate)
            : schedule.endDate;
      const occurrences = computeOccurrenceDates({
        frequency: schedule.frequency,
        startDate,
        dueDay: schedule.dueDay,
        totalOccurrences: schedule.totalOccurrences,
        startingOccurrence: schedule.startingOccurrence,
        horizonMonths: occurrenceHorizonMonths(startDate, ctx),
        endDate,
      });
      for (const occ of occurrences) {
        const ref = ctx.months.find((m) => isInMonth(occ.date, m));
        if (!ref) continue;
        addToMonthMap(accumulator, ref, 'expense', perOccurrence.negate());
      }
    }
    const byMonth: MonthDelta[] = toByMonth(ctx.months, accumulator);
    return { leverId: lever.id, byMonth, events };
  }

  // op === 'add'
  const amount =
    lever.amount !== undefined ? Money.fromString(lever.amount, 'BRL') : Money.zero('BRL');
  const startRef = lever.startMonth ?? ctx.months[0];
  const startDate = monthRefToDate(startRef);
  const endDate =
    lever.endMonth !== undefined
      ? new Date(lever.endMonth.year, lever.endMonth.month, 0) // last day of endMonth
      : undefined;
  const occurrences = computeOccurrenceDates({
    frequency: lever.frequency ?? 'monthly',
    startDate,
    dueDay: 1,
    totalOccurrences: null,
    startingOccurrence: 1,
    horizonMonths: occurrenceHorizonMonths(startDate, ctx),
    endDate,
  });
  for (const occ of occurrences) {
    const ref = ctx.months.find((m) => isInMonth(occ.date, m));
    if (!ref) continue;
    addToMonthMap(accumulator, ref, 'expense', amount);
  }

  const byMonth: MonthDelta[] = toByMonth(ctx.months, accumulator);
  return { leverId: lever.id, byMonth, events };
}

/**
 * Convert a schedule's stored per-occurrence amount to a BRL `Money`, never throwing.
 *
 * The native magnitude is labelled BRL up front (the SAME trick MonthSummaryService
 * and MonthOverviewService use): the rate is applied via Money.multiply, which keeps
 * the currency label, so a BRL-labelled input always yields a BRL-labelled result —
 * which the downstream BRL accumulator requires.
 *
 * BRL schedules pass through unchanged. For a non-BRL schedule, resolve the rate the
 * same way the rest of the app values foreign amounts: prefer the income source
 * config rate for the schedule's source account (`income_source_configs.exchange_rate`,
 * kept in sync with the live USD→BRL rate by FxRateService), then fall back to the
 * global `fx_rates` cache (`FxRateService.getRate(currency, 'BRL')`).
 *
 * The simulator is BRL-only in v1, so if NEITHER source yields a usable positive
 * rate the stored amount is treated as already-BRL (rate 1:1) instead of throwing —
 * a missing rate must never hard-500 a run.
 */
async function normalizeToBrl(
  db: DbExecutor,
  amount: string,
  currency: string,
  sourceAccountId: string,
): Promise<Money> {
  const brlAmount = Money.fromString(amount, 'BRL');
  if (currency === 'BRL') return brlAmount;

  const [config] = await db
    .select({ exchangeRate: incomeSourceConfigs.exchangeRate })
    .from(incomeSourceConfigs)
    .where(eq(incomeSourceConfigs.accountId, sourceAccountId));
  const configRate = config?.exchangeRate ?? null;
  const cachedRate =
    configRate == null ? await new FxRateService(db).getRate(currency, 'BRL') : null;
  const rate = configRate ?? cachedRate;

  // No usable positive rate → BRL-only fallback: treat the stored amount as
  // already BRL (rate 1:1). We validate the rate here rather than letting it
  // throw downstream, so an invalid stored rate falls back instead of 500ing.
  const numericRate = rate == null ? Number.NaN : Number(rate);
  if (!Number.isFinite(numericRate) || numericRate <= 0) {
    return brlAmount;
  }
  return brlAmount.multiply(numericRate);
}
