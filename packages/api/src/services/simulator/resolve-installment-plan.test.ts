import type { DbExecutor } from '@fc/db';
import type { MonthRef, SimLever } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { resolveInstallmentPlan } from './resolve-installment-plan.ts';

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

describe('resolveInstallmentPlan', () => {
  it('charges amount for the finite window [startMonth, startMonth + N - 1]', () => {
    const lever: SimLever = {
      kind: 'installment_plan',
      id: 'ip',
      amount: '500.00',
      installments: 3,
      startMonth: { month: 7, year: 2026 },
      label: 'Plano',
    };
    const delta = resolveInstallmentPlan(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
    const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));

    // 3 parcelas land on July, August, September; the rest stay 0.
    expect(byKey.get('2026-6')?.expenseDelta).toBe('0.00');
    expect(byKey.get('2026-7')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-8')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-9')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-10')?.expenseDelta).toBe('0.00');
    expect(byKey.get('2026-11')?.expenseDelta).toBe('0.00');

    // Income is never touched.
    for (const m of delta.byMonth) {
      expect(m.incomeDelta).toBe('0.00');
    }

    // One annotation event lands in startMonth.
    expect(delta.leverId).toBe('ip');
    expect(delta.events).toEqual([
      { month: 7, year: 2026, label: 'Plano', sign: 'outflow', amount: '500.00' },
    ]);
  });

  it('clamps parcelas that fall past the horizon end', () => {
    const lever: SimLever = {
      kind: 'installment_plan',
      id: 'ip2',
      amount: '500.00',
      installments: 12,
      startMonth: { month: 10, year: 2026 },
      label: 'Plano longo',
    };
    const delta = resolveInstallmentPlan(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
    const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));

    // Only the in-window parcelas appear; everything before startMonth is 0.
    expect(byKey.get('2026-9')?.expenseDelta).toBe('0.00');
    expect(byKey.get('2026-10')?.expenseDelta).toBe('500.00');
    expect(byKey.get('2026-11')?.expenseDelta).toBe('500.00');

    // Parcelas past the horizon simply don't appear (clamped, not present).
    expect(byKey.size).toBe(6);

    for (const m of delta.byMonth) {
      expect(m.incomeDelta).toBe('0.00');
    }
  });
});
