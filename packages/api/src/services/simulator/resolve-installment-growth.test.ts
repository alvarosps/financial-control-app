import type { DbExecutor } from '@fc/db';
import type { MonthRef, SimLever } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { resolveInstallmentGrowth } from './resolve-installment-growth.ts';

function horizonMonths(start: MonthRef, n: number): MonthRef[] {
  const out: MonthRef[] = [];
  for (let i = 0; i < n; i++) {
    const m0 = start.month - 1 + i;
    out.push({ month: (((m0 % 12) + 12) % 12) + 1, year: start.year + Math.floor(m0 / 12) });
  }
  return out;
}

const ctx = (start: MonthRef, n: number) => ({
  months: horizonMonths(start, n),
  horizon: n,
  asOf: new Date(start.year, start.month - 1, 1),
});

// The resolver is amount-driven and reads no user data, so no DB is needed.
const db = null as unknown as DbExecutor;

describe('resolveInstallmentGrowth', () => {
  it('accumulates linearly: month m carries monthlyAmount × k from fromMonth', () => {
    const lever: SimLever = {
      kind: 'installment_growth',
      id: 'inst',
      monthlyAmount: '500.00',
      fromMonth: { month: 6, year: 2026 },
      label: 'Parcela nova/mês',
    };
    const delta = resolveInstallmentGrowth(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
    const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));

    // Starting at fromMonth, each month begins a NEW installment and every one
    // runs to the horizon end → linear growth 500 × k (k = 1..6).
    expect(byKey.get('2026-6')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-7')?.expenseDelta).toBe('1000.00');
    expect(byKey.get('2026-8')?.expenseDelta).toBe('1500.00');
    expect(byKey.get('2026-9')?.expenseDelta).toBe('2000.00');
    expect(byKey.get('2026-10')?.expenseDelta).toBe('2500.00');
    expect(byKey.get('2026-11')?.expenseDelta).toBe('3000.00');

    // Income is never touched.
    for (const m of delta.byMonth) {
      expect(m.incomeDelta).toBe('0.00');
    }

    // One annotation event lands in fromMonth.
    expect(delta.events).toEqual([
      { month: 6, year: 2026, label: 'Parcela nova/mês', sign: 'outflow', amount: '500.00' },
    ]);
  });

  it('stays 0 before a mid-window fromMonth, then accumulates linearly from it', () => {
    const lever: SimLever = {
      kind: 'installment_growth',
      id: 'inst2',
      monthlyAmount: '500.00',
      fromMonth: { month: 8, year: 2026 },
      label: 'Parcela nova/mês',
    };
    const delta = resolveInstallmentGrowth(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
    const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));

    // Before fromMonth → no burden.
    expect(byKey.get('2026-6')?.expenseDelta).toBe('0.00');
    expect(byKey.get('2026-7')?.expenseDelta).toBe('0.00');
    // From fromMonth → linear 500 × k.
    expect(byKey.get('2026-8')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-9')?.expenseDelta).toBe('1000.00');
    expect(byKey.get('2026-10')?.expenseDelta).toBe('1500.00');
    expect(byKey.get('2026-11')?.expenseDelta).toBe('2000.00');

    for (const m of delta.byMonth) {
      expect(m.incomeDelta).toBe('0.00');
    }

    // The single annotation lands in fromMonth (August).
    expect(delta.events).toEqual([
      { month: 8, year: 2026, label: 'Parcela nova/mês', sign: 'outflow', amount: '500.00' },
    ]);
  });

  it('with termMonths, the burden grows then holds steady (rolling window)', () => {
    const lever: SimLever = {
      kind: 'installment_growth',
      id: 'inst3',
      monthlyAmount: '500.00',
      termMonths: 3, // each installment lasts 3 months
      fromMonth: { month: 6, year: 2026 },
      label: 'Parcela nova/mês',
    };
    const delta = resolveInstallmentGrowth(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
    const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));

    // Grows for the first `termMonths` (k = 1..3), then plateaus at 500 × 3 once
    // the oldest installment drops off as a new one begins (min(k, 3)).
    expect(byKey.get('2026-6')?.expenseDelta).toBe('500.00'); // k=1 → 1×500
    expect(byKey.get('2026-7')?.expenseDelta).toBe('1000.00'); // k=2 → 2×500
    expect(byKey.get('2026-8')?.expenseDelta).toBe('1500.00'); // k=3 → 3×500
    expect(byKey.get('2026-9')?.expenseDelta).toBe('1500.00'); // k=4, capped at 3
    expect(byKey.get('2026-10')?.expenseDelta).toBe('1500.00'); // k=5, capped at 3
    expect(byKey.get('2026-11')?.expenseDelta).toBe('1500.00'); // k=6, capped at 3
  });

  it('termMonths = 1 means each installment lasts a single month (flat burden)', () => {
    const lever: SimLever = {
      kind: 'installment_growth',
      id: 'inst4',
      monthlyAmount: '500.00',
      termMonths: 1,
      fromMonth: { month: 6, year: 2026 },
      label: 'Parcela nova/mês',
    };
    const delta = resolveInstallmentGrowth(db, 'user', lever, ctx({ month: 6, year: 2026 }, 4));
    for (const m of delta.byMonth) {
      expect(m.expenseDelta).toBe('500.00');
    }
  });
});
