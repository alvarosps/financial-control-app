import type { DbExecutor } from '@fc/db';
import type { MonthRef, SimLever } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { type ResolveContext, resolveLever } from './resolve-lever.ts';

function horizonMonths(start: MonthRef, n: number): MonthRef[] {
  const out: MonthRef[] = [];
  for (let i = 0; i < n; i++) {
    const m0 = start.month - 1 + i;
    out.push({ month: (((m0 % 12) + 12) % 12) + 1, year: start.year + Math.floor(m0 / 12) });
  }
  return out;
}

const ctx = (start: MonthRef, n: number): ResolveContext => ({
  months: horizonMonths(start, n),
  horizon: n,
  asOf: new Date(start.year, start.month - 1, 1),
});

// The two new resolvers are amount-driven and read no user data → no DB needed.
const db = null as unknown as DbExecutor;

describe('resolveLever dispatch', () => {
  it('routes average_spend to a positive flat expenseDelta', async () => {
    const lever: SimLever = {
      kind: 'average_spend',
      id: 'avg',
      amount: '5000.00',
      fromMonth: { month: 6, year: 2026 },
      label: 'Gasto médio',
    };
    const delta = await resolveLever(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
    expect(delta.leverId).toBe('avg');
    for (const m of delta.byMonth) {
      expect(m.expenseDelta).toBe('5000.00');
      expect(m.incomeDelta).toBe('0.00');
    }
  });

  it('routes installment_growth to an accumulating expenseDelta', async () => {
    const lever: SimLever = {
      kind: 'installment_growth',
      id: 'grow',
      monthlyAmount: '500.00',
      fromMonth: { month: 6, year: 2026 },
      label: 'Parcela nova/mês',
    };
    const delta = await resolveLever(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
    expect(delta.leverId).toBe('grow');
    const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
    // Linear accumulation 500 × k for k = 1..6.
    expect(byKey.get('2026-6')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-7')?.expenseDelta).toBe('1000.00');
    expect(byKey.get('2026-8')?.expenseDelta).toBe('1500.00');
    expect(byKey.get('2026-9')?.expenseDelta).toBe('2000.00');
    expect(byKey.get('2026-10')?.expenseDelta).toBe('2500.00');
    expect(byKey.get('2026-11')?.expenseDelta).toBe('3000.00');
    // A single annotation event marks fromMonth.
    expect(delta.events).toHaveLength(1);
  });

  it('routes installment_plan to a finite-window expenseDelta', async () => {
    const lever: SimLever = {
      kind: 'installment_plan',
      id: 'plan',
      amount: '500.00',
      installments: 3,
      startMonth: { month: 7, year: 2026 },
      label: 'Plano',
    };
    const delta = await resolveLever(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
    expect(delta.leverId).toBe('plan');
    const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
    // Three parcelas over 2026-07..2026-09; nothing before or after.
    expect(byKey.get('2026-6')?.expenseDelta).toBe('0.00');
    expect(byKey.get('2026-7')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-8')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-9')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-10')?.expenseDelta).toBe('0.00');
    expect(byKey.get('2026-11')?.expenseDelta).toBe('0.00');
    for (const m of delta.byMonth) {
      expect(m.incomeDelta).toBe('0.00');
    }
  });
});
