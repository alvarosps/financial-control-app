import type { DbExecutor } from '@fc/db';
import type { MonthRef, SimLever } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { resolveAverageSpend } from './resolve-average-spend.ts';

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

describe('resolveAverageSpend', () => {
  it('adds a flat expense delta from fromMonth to the horizon end, income 0, no events', () => {
    const lever: SimLever = {
      kind: 'average_spend',
      id: 'avg',
      amount: '500.00',
      fromMonth: { month: 7, year: 2026 },
      label: 'Gasto médio',
    };
    const delta = resolveAverageSpend(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
    const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));

    // June is before fromMonth → no spend.
    expect(byKey.get('2026-6')?.expenseDelta).toBe('0.00');
    // July..November (window end) all carry the flat amount.
    expect(byKey.get('2026-7')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-8')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-9')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-10')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-11')?.expenseDelta).toBe('500.00');

    // Income is never touched.
    for (const m of delta.byMonth) {
      expect(m.incomeDelta).toBe('0.00');
    }

    // The lever surfaces no display events.
    expect(delta.events).toEqual([]);
  });

  it('adds the flat amount to every month when fromMonth is the window start', () => {
    const lever: SimLever = {
      kind: 'average_spend',
      id: 'avg2',
      amount: '5000.00',
      fromMonth: { month: 6, year: 2026 },
      label: 'Gasto médio',
    };
    const delta = resolveAverageSpend(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
    for (const m of delta.byMonth) {
      expect(m.expenseDelta).toBe('5000.00');
      expect(m.incomeDelta).toBe('0.00');
    }
    expect(delta.events).toEqual([]);
  });
});
