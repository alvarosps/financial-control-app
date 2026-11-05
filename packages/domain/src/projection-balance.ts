// packages/domain/src/projection-balance.ts
import { type MonthRef, monthIndex } from '@fc/shared';
import { Money } from './money.ts';

const BRL = 'BRL';
const money = (n: number): Money => Money.fromNumber(n, BRL);

/**
 * Per-month canonical buckets (BRL numbers, already rounded at the service
 * boundary). `lever` buckets hold simulation overlay deltas; `total` includes
 * `lever`; `net = income.total - expenses.total`.
 */
export type MonthCore = {
  month: number;
  year: number;
  income: { base: number; familyLoan: number; lever: number; total: number };
  expenses: {
    creditCard: number;
    loan: number;
    charge: number;
    other: number;
    lever: number;
    total: number;
  };
  net: number;
  events: Array<{ label: string; amount: number; sign: 'inflow' | 'outflow' }>;
};

/** A {@link MonthCore} with its running-balance anchors resolved. */
export type ProjectedMonth = MonthCore & { openingBalance: number; endingBalance: number };

/** A single lever's per-month income/expense adjustment (money strings). */
export type MonthDelta = {
  month: number;
  year: number;
  incomeDelta: string;
  expenseDelta: string;
};

/** A labelled point-in-time effect of a lever, shown on the month it lands. */
export type LeverEvent = {
  month: number;
  year: number;
  label: string;
  sign: 'inflow' | 'outflow';
  amount: string;
};

/** The fully resolved effect of one lever across the horizon. */
export type ResolvedDelta = { leverId: string; byMonth: MonthDelta[]; events: LeverEvent[] };

export type ProjectionKpis = {
  openingNow: number;
  endingBaseline: number;
  endingSimulated: number;
  delta: number;
};

export type Trough = { month: number; year: number; balance: number };

export type ProjectionAlerts = {
  firstNegativeMonthBaseline: MonthRef | null;
  firstNegativeMonthSimulated: MonthRef | null;
  troughBaseline: Trough;
  troughSimulated: Trough;
};

/**
 * Fold a chain of monthly cores into running balances.
 *
 * Invariant: `month0.openingBalance === openingBalance`; for each month
 * `endingBalance = openingBalance + net`, and the next month's opening is the
 * previous month's ending. All arithmetic flows through `Money` (BRL, 2dp,
 * ROUND_HALF_UP) so per-step rounding is deterministic across the horizon.
 */
export function foldRunningBalance(cores: MonthCore[], openingBalance: string): ProjectedMonth[] {
  const result: ProjectedMonth[] = [];
  let opening = Money.fromString(openingBalance, BRL);
  for (const c of cores) {
    const ending = opening.add(money(c.net));
    result.push({ ...c, openingBalance: opening.toNumber(), endingBalance: ending.toNumber() });
    opening = ending;
  }
  return result;
}

/**
 * Overlay resolved lever deltas onto baseline cores, returning NEW cores.
 *
 * For each month: sums every lever's income/expense delta into the `lever`
 * buckets, recomputes `income.total` / `expenses.total` / `net`, and attaches
 * the levers' events landing on that month. Deltas/events whose (month, year)
 * fall outside the supplied cores are ignored. All arithmetic flows through
 * `Money` (BRL, 2dp, ROUND_HALF_UP). Pure — input cores are not mutated.
 */
export function applyDeltas(cores: MonthCore[], deltas: ResolvedDelta[]): MonthCore[] {
  return cores.map((c) => {
    let incomeLever = Money.zero(BRL);
    let expenseLever = Money.zero(BRL);
    const events: MonthCore['events'] = [];

    for (const d of deltas) {
      for (const md of d.byMonth) {
        if (md.month === c.month && md.year === c.year) {
          incomeLever = incomeLever.add(Money.fromString(md.incomeDelta, BRL));
          expenseLever = expenseLever.add(Money.fromString(md.expenseDelta, BRL));
        }
      }
      for (const ev of d.events) {
        if (ev.month === c.month && ev.year === c.year) {
          events.push({
            label: ev.label,
            amount: Money.fromString(ev.amount, BRL).toNumber(),
            sign: ev.sign,
          });
        }
      }
    }

    const incomeLeverN = incomeLever.toNumber();
    const expenseLeverN = expenseLever.toNumber();
    const incomeTotal = money(c.income.base)
      .add(money(c.income.familyLoan))
      .add(money(incomeLeverN));
    const expensesTotal = money(c.expenses.creditCard)
      .add(money(c.expenses.loan))
      .add(money(c.expenses.charge))
      .add(money(c.expenses.other))
      .add(money(expenseLeverN));
    const net = incomeTotal.subtract(expensesTotal);

    return {
      ...c,
      income: { ...c.income, lever: incomeLeverN, total: incomeTotal.toNumber() },
      expenses: { ...c.expenses, lever: expenseLeverN, total: expensesTotal.toNumber() },
      net: net.toNumber(),
      events,
    };
  });
}

/**
 * Headline KPIs: opening cash now, ending balance of the final baseline and
 * simulated months, and `endingSimulated - endingBaseline`. Empty horizons
 * fall back to `openingNow` for both ending balances (delta 0). Arithmetic
 * flows through `Money` (BRL, 2dp, ROUND_HALF_UP).
 */
export function computeKpis(
  baseline: ProjectedMonth[],
  simulated: ProjectedMonth[],
  openingNow: number,
): ProjectionKpis {
  const endingBaseline =
    baseline.length > 0 ? baseline[baseline.length - 1].endingBalance : openingNow;
  const endingSimulated =
    simulated.length > 0 ? simulated[simulated.length - 1].endingBalance : openingNow;
  const delta = money(endingSimulated).subtract(money(endingBaseline));
  return {
    openingNow: money(openingNow).toNumber(),
    endingBaseline: money(endingBaseline).toNumber(),
    endingSimulated: money(endingSimulated).toNumber(),
    delta: delta.toNumber(),
  };
}

function firstNegativeMonth(months: ProjectedMonth[]): MonthRef | null {
  for (const m of months) {
    if (m.endingBalance < 0) return { month: m.month, year: m.year };
  }
  return null;
}

function trough(months: ProjectedMonth[]): Trough {
  // Unreachable in practice: `horizon` is schema-enforced >= 1, so `simulated`
  // (and `baseline`) are never empty. Kept as a defensive zeroed sentinel.
  if (months.length === 0) return { month: 0, year: 0, balance: 0 };
  let lowest = months[0];
  for (const m of months) {
    if (m.endingBalance < lowest.endingBalance) lowest = m;
  }
  return { month: lowest.month, year: lowest.year, balance: lowest.endingBalance };
}

/**
 * Risk markers for both the baseline and simulated chains: the first month
 * whose ending balance dips below zero (null if never), and the trough
 * (minimum ending balance) over the horizon. Empty horizons yield a null
 * first-negative and a zeroed trough.
 */
export function computeAlerts(
  baseline: ProjectedMonth[],
  simulated: ProjectedMonth[],
): ProjectionAlerts {
  return {
    firstNegativeMonthBaseline: firstNegativeMonth(baseline),
    firstNegativeMonthSimulated: firstNegativeMonth(simulated),
    troughBaseline: trough(baseline),
    troughSimulated: trough(simulated),
  };
}

/** Analysis result for a `savings_goal` lever (BRL numbers, rounded at the boundary). */
export type SavingsGoal = {
  requiredMonthly: number;
  projectedAtTarget: number;
  feasible: boolean;
  /**
   * True when the goal's target month falls past the last simulated month. In
   * that case `projectedAtTarget` is the last simulated ending (best available
   * estimate, NOT the true balance at the target), so `feasible` is an estimate.
   */
  beyondHorizon: boolean;
};

/**
 * Pure analysis for a `savings_goal` lever (the lever itself emits no delta).
 *
 * `monthsUntil` is the REAL calendar distance to the target month —
 * `monthIndex(byMonth) - monthIndex(simulated[0]) + 1`, guarded `>= 1` — even
 * when the target lands beyond the projection horizon. This keeps the headline
 * `requiredMonthly` honest for long-horizon goals (a horizon clamp would divide
 * by too few months and understate the per-month contribution).
 *
 * `projectedAtTarget` is the target month's `endingBalance` when it lies inside
 * the horizon; if the target lands PAST the last simulated month the last
 * simulated ending is returned as the best available estimate (`beyondHorizon`
 * true); if it lands BEFORE the first simulated month (a past / degenerate
 * target) the FIRST simulated ending is returned as the nearest in-range point
 * (`beyondHorizon` false, `monthsUntil` clamped to 1). An empty horizon yields
 * all-zero / infeasible.
 *
 * `requiredMonthly = max(0, (target - openingBalance) / monthsUntil)` — the flat
 * monthly contribution that would reach `target` from `openingBalance`, computed
 * through `Money` (BRL, 2dp, ROUND_HALF_UP). `feasible` compares the projected
 * ending against the target through `Money` (no float `>=`); when
 * `beyondHorizon` it is an estimate based on the last simulated ending.
 */
export function computeSavingsGoal(
  simulated: ProjectedMonth[],
  openingBalance: number,
  target: string,
  byMonth: MonthRef,
): SavingsGoal {
  if (simulated.length === 0) {
    return { requiredMonthly: 0, projectedAtTarget: 0, feasible: false, beyondHorizon: false };
  }

  const matchIndex = simulated.findIndex(
    (m) => m.month === byMonth.month && m.year === byMonth.year,
  );
  const lastIndex = simulated.length - 1;
  const beyondHorizon = matchIndex < 0 && monthIndex(byMonth) > monthIndex(simulated[lastIndex]);
  // A target before the first simulated month (past / degenerate) has no match
  // and is not beyond-horizon; clamp it to the first month so `projectedAtTarget`
  // is the nearest in-range ending rather than the (wrong) last month's ending.
  const beforeFirst = matchIndex < 0 && monthIndex(byMonth) < monthIndex(simulated[0]);
  const i = matchIndex >= 0 ? matchIndex : beforeFirst ? 0 : lastIndex;

  const rawMonthsUntil = monthIndex(byMonth) - monthIndex(simulated[0]) + 1;
  const monthsUntil = Math.max(1, rawMonthsUntil);

  const projectedAtTarget = simulated[i].endingBalance;
  const requiredRaw = Money.fromString(target, BRL)
    .subtract(Money.fromNumber(openingBalance, BRL))
    .divide(monthsUntil);
  const requiredMonthly = requiredRaw.isNegative() ? 0 : requiredRaw.toNumber();

  const projectedMoney = Money.fromNumber(projectedAtTarget, BRL);
  const targetMoney = Money.fromString(target, BRL);
  const feasible = projectedMoney.isGreaterThan(targetMoney) || projectedMoney.equals(targetMoney);

  return {
    requiredMonthly,
    projectedAtTarget,
    feasible,
    beyondHorizon,
  };
}
