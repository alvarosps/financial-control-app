// packages/domain/src/projection-balance.test.ts
import { describe, expect, it } from 'vitest';
import {
  applyDeltas,
  computeAlerts,
  computeKpis,
  computeSavingsGoal,
  foldRunningBalance,
  type MonthCore,
  type ProjectedMonth,
  type ResolvedDelta,
} from './projection-balance.ts';

const core = (
  month: number,
  year: number,
  incomeTotal: number,
  expenseTotal: number,
): MonthCore => ({
  month,
  year,
  income: { base: incomeTotal, familyLoan: 0, lever: 0, total: incomeTotal },
  expenses: {
    creditCard: 0,
    loan: 0,
    charge: 0,
    other: expenseTotal,
    lever: 0,
    total: expenseTotal,
  },
  net: incomeTotal - expenseTotal,
  events: [],
});

describe('foldRunningBalance', () => {
  it('sets month0 opening to the override and carries the chain', () => {
    const cores: MonthCore[] = [core(6, 2026, 5000, 3000), core(7, 2026, 5000, 4000)];
    const projected = foldRunningBalance(cores, '1000.00');

    expect(projected[0].openingBalance).toBe(1000);
    expect(projected[0].endingBalance).toBe(3000); // 1000 + (5000-3000)
    expect(projected[1].openingBalance).toBe(3000);
    expect(projected[1].endingBalance).toBe(4000); // 3000 + (5000-4000)
  });

  it('holds the invariant endingBalance(m) === openingBalance(m+1)', () => {
    const cores: MonthCore[] = [
      core(1, 2026, 4200, 3990),
      core(2, 2026, 4200, 5100),
      core(3, 2026, 4200, 2800),
    ];
    const projected = foldRunningBalance(cores, '0.00');
    for (let i = 0; i < projected.length - 1; i++) {
      expect(projected[i + 1].openingBalance).toBe(projected[i].endingBalance);
    }
  });

  it('preserves Decimal precision across the horizon (33.33 x 3 drift case)', () => {
    // Three months each netting +33.33 must land exactly on 100.00, not 99.99,
    // because the fold rounds through Money (ROUND_HALF_UP, 2dp) each step.
    const cores: MonthCore[] = [
      core(1, 2026, 33.33, 0),
      core(2, 2026, 33.33, 0),
      core(3, 2026, 33.33, 0),
    ];
    const projected = foldRunningBalance(cores, '0.01');
    expect(projected[2].endingBalance).toBe(100);
  });

  it('returns an empty array for no cores', () => {
    expect(foldRunningBalance([], '500.00')).toEqual([]);
  });
});

describe('applyDeltas', () => {
  const baseCores = (): MonthCore[] => [core(6, 2026, 5000, 3000), core(7, 2026, 5000, 3000)];

  it('sums income/expense lever deltas and recomputes totals + net', () => {
    const deltas: ResolvedDelta[] = [
      {
        leverId: 'a',
        byMonth: [
          { month: 6, year: 2026, incomeDelta: '500.00', expenseDelta: '0.00' },
          { month: 7, year: 2026, incomeDelta: '0.00', expenseDelta: '200.00' },
        ],
        events: [],
      },
      {
        leverId: 'b',
        byMonth: [{ month: 6, year: 2026, incomeDelta: '100.00', expenseDelta: '50.00' }],
        events: [],
      },
    ];
    const out = applyDeltas(baseCores(), deltas);

    // June: +600 income, +50 expense across two levers
    expect(out[0].income.lever).toBe(600);
    expect(out[0].income.total).toBe(5600); // base 5000 + familyLoan 0 + lever 600
    expect(out[0].expenses.lever).toBe(50);
    expect(out[0].expenses.total).toBe(3050);
    expect(out[0].net).toBe(2550); // 5600 - 3050

    // July: +200 expense only
    expect(out[1].income.lever).toBe(0);
    expect(out[1].expenses.lever).toBe(200);
    expect(out[1].expenses.total).toBe(3200);
    expect(out[1].net).toBe(1800); // 5000 - 3200
  });

  it('attaches events to the matching month and is pure (no input mutation)', () => {
    const input = baseCores();
    const deltas: ResolvedDelta[] = [
      {
        leverId: 'evt',
        byMonth: [{ month: 7, year: 2026, incomeDelta: '0.00', expenseDelta: '2500.00' }],
        events: [{ month: 7, year: 2026, label: 'Trip', sign: 'outflow', amount: '2500.00' }],
      },
    ];
    const out = applyDeltas(input, deltas);

    expect(out[1].events).toEqual([{ label: 'Trip', amount: 2500, sign: 'outflow' }]);
    expect(out[0].events).toEqual([]);
    // input untouched
    expect(input[1].events).toEqual([]);
    expect(input[1].expenses.lever).toBe(0);
    expect(out).not.toBe(input);
    expect(out[1]).not.toBe(input[1]);
  });

  it('ignores deltas outside the cores window', () => {
    const deltas: ResolvedDelta[] = [
      {
        leverId: 'oob',
        byMonth: [{ month: 12, year: 2026, incomeDelta: '999.00', expenseDelta: '0.00' }],
        events: [{ month: 12, year: 2026, label: 'Bonus', sign: 'inflow', amount: '999.00' }],
      },
    ];
    const out = applyDeltas(baseCores(), deltas);
    expect(out[0].income.lever).toBe(0);
    expect(out[1].income.lever).toBe(0);
    expect(out.flatMap((m) => m.events)).toEqual([]);
  });
});

const projected = (
  month: number,
  year: number,
  openingBalance: number,
  endingBalance: number,
): ProjectedMonth => ({
  ...core(month, year, 0, 0),
  openingBalance,
  endingBalance,
});

describe('computeKpis', () => {
  it('computes ending balances and the simulated-minus-baseline delta', () => {
    const baseline = [projected(6, 2026, 1000, 1500), projected(7, 2026, 1500, 2000)];
    const simulated = [projected(6, 2026, 1000, 1800), projected(7, 2026, 1800, 2600)];
    const kpis = computeKpis(baseline, simulated, 1000);

    expect(kpis.openingNow).toBe(1000);
    expect(kpis.endingBaseline).toBe(2000);
    expect(kpis.endingSimulated).toBe(2600);
    expect(kpis.delta).toBe(600); // 2600 - 2000
  });

  it('treats empty horizons as opening for ending balances', () => {
    const kpis = computeKpis([], [], 750);
    expect(kpis.endingBaseline).toBe(750);
    expect(kpis.endingSimulated).toBe(750);
    expect(kpis.delta).toBe(0);
  });
});

describe('computeAlerts', () => {
  it('reports first-negative month and trough for baseline and simulated', () => {
    const baseline = [
      projected(6, 2026, 1000, 500),
      projected(7, 2026, 500, -200),
      projected(8, 2026, -200, -800),
    ];
    const simulated = [
      projected(6, 2026, 1000, 900),
      projected(7, 2026, 900, 400),
      projected(8, 2026, 400, 100),
    ];
    const alerts = computeAlerts(baseline, simulated);

    expect(alerts.firstNegativeMonthBaseline).toEqual({ month: 7, year: 2026 });
    expect(alerts.firstNegativeMonthSimulated).toBeNull();
    expect(alerts.troughBaseline).toEqual({ month: 8, year: 2026, balance: -800 });
    expect(alerts.troughSimulated).toEqual({ month: 8, year: 2026, balance: 100 });
  });

  it('returns null first-negative and a zero trough for empty horizons', () => {
    const alerts = computeAlerts([], []);
    expect(alerts.firstNegativeMonthBaseline).toBeNull();
    expect(alerts.firstNegativeMonthSimulated).toBeNull();
    expect(alerts.troughBaseline).toEqual({ month: 0, year: 0, balance: 0 });
    expect(alerts.troughSimulated).toEqual({ month: 0, year: 0, balance: 0 });
  });
});

describe('computeSavingsGoal', () => {
  // 12 calendar-sequential months starting Jun 2026 (Jun..May 2027), each
  // ending at 1000, so monthIndex distance is real and monotonic.
  const twelveMonths = (): ProjectedMonth[] =>
    Array.from({ length: 12 }, (_, i) => {
      const zero = 6 - 1 + i; // 0-based absolute from Jun 2026
      return projected((zero % 12) + 1, 2026 + Math.floor(zero / 12), 1000, 1000);
    });

  it('computes the flat required monthly to reach a target over the horizon', () => {
    // 12 sequential months; target 13000 from opening 1000 → (13000-1000)/12 = 1000.00
    const simulated = twelveMonths();
    const byMonth = { month: simulated[11].month, year: simulated[11].year };
    const goal = computeSavingsGoal(simulated, 1000, '13000', byMonth);

    expect(goal.requiredMonthly).toBe(1000);
    expect(goal.beyondHorizon).toBe(false);
  });

  it('marks a goal feasible when the projected ending balance meets the target', () => {
    const cores: MonthCore[] = [core(6, 2026, 6000, 4000), core(7, 2026, 6000, 4000)];
    const simulated = foldRunningBalance(cores, '1000.00');
    // endings: 3000, then 5000
    const byMonth = { month: 7, year: 2026 };
    const goal = computeSavingsGoal(simulated, 1000, '5000', byMonth);

    expect(goal.projectedAtTarget).toBe(5000);
    expect(goal.feasible).toBe(true);
    expect(goal.beyondHorizon).toBe(false);
    expect(goal.requiredMonthly).toBe(2000); // (5000-1000)/2
  });

  it('treats an exact-boundary ending equal to the target as feasible (Money, no float)', () => {
    const cores: MonthCore[] = [core(6, 2026, 6000, 4000), core(7, 2026, 6000, 4000)];
    const simulated = foldRunningBalance(cores, '1000.00');
    // ending at Jul 2026 is exactly 5000.00
    const goal = computeSavingsGoal(simulated, 1000, '5000.00', { month: 7, year: 2026 });

    expect(goal.projectedAtTarget).toBe(5000);
    expect(goal.feasible).toBe(true);
  });

  it('marks a goal infeasible when the projection falls short of the target', () => {
    const cores: MonthCore[] = [core(6, 2026, 4500, 4000), core(7, 2026, 4500, 4000)];
    const simulated = foldRunningBalance(cores, '1000.00');
    // endings: 1500, then 2000
    const byMonth = { month: 7, year: 2026 };
    const goal = computeSavingsGoal(simulated, 1000, '5000', byMonth);

    expect(goal.projectedAtTarget).toBe(2000);
    expect(goal.feasible).toBe(false);
    expect(goal.requiredMonthly).toBe(2000); // (5000-1000)/2
  });

  it('clamps the required monthly at zero when already past the target', () => {
    const cores: MonthCore[] = [core(6, 2026, 5000, 3000)];
    const simulated = foldRunningBalance(cores, '6000.00');
    const goal = computeSavingsGoal(simulated, 6000, '5000', { month: 6, year: 2026 });

    expect(goal.requiredMonthly).toBe(0); // (5000-6000)/1 clamped to 0
  });

  it('uses the real calendar distance when byMonth is beyond the horizon', () => {
    // Horizon of 6 months (Jun..Nov 2026); goal target is May 2027 — 12 months
    // out from the first simulated month. monthsUntil must be 12, NOT 6.
    const simulated = twelveMonths().slice(0, 6); // Jun..Nov 2026, each ending 1000
    const goal = computeSavingsGoal(simulated, 1000, '13000', { month: 5, year: 2027 });

    expect(goal.beyondHorizon).toBe(true);
    // monthIndex(2027-05) - monthIndex(2026-06) + 1 = (2027*12+5) - (2026*12+6) + 1 = 12
    expect(goal.requiredMonthly).toBe(1000); // (13000-1000)/12, NOT /6 (which would be 2000)
    // best-available estimate: last simulated ending
    expect(goal.projectedAtTarget).toBe(1000);
    expect(goal.feasible).toBe(false);
  });

  it('clamps a past target (before the first simulated month) to the first ending, not the last', () => {
    // Two months Jun..Jul 2026 with distinct endings; the target month is May
    // 2026 — BEFORE the first simulated month. projectedAtTarget must be the
    // FIRST month's ending (nearest in-range point), not the last month's, and
    // beyondHorizon must stay false. monthsUntil clamps to 1.
    const cores: MonthCore[] = [core(6, 2026, 5000, 2000), core(7, 2026, 5000, 2000)];
    const simulated = foldRunningBalance(cores, '1000.00');
    // endings: Jun = 4000, Jul = 7000
    const goal = computeSavingsGoal(simulated, 1000, '5000', { month: 5, year: 2026 });

    expect(goal.beyondHorizon).toBe(false);
    expect(goal.projectedAtTarget).toBe(4000); // first month's ending, NOT 7000
    expect(goal.requiredMonthly).toBe(4000); // (5000-1000)/1 (monthsUntil clamped to 1)
    expect(goal.feasible).toBe(false); // 4000 < 5000
  });

  it('returns zeros and infeasible for an empty horizon', () => {
    const goal = computeSavingsGoal([], 1000, '5000', { month: 6, year: 2026 });
    expect(goal).toEqual({
      requiredMonthly: 0,
      projectedAtTarget: 0,
      feasible: false,
      beyondHorizon: false,
    });
  });
});
