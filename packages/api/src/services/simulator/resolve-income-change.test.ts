import type { DbExecutor } from '@fc/db';
import type { MonthRef, SimLever } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../../test/with-rollback.ts';
import { resolveIncomeChange } from './resolve-income-change.ts';

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

describe('resolveIncomeChange', () => {
  it('add: places a monthly income from fromMonth onward as a positive income delta', async () => {
    await withRollback(async (db: DbExecutor) => {
      const lever: SimLever = {
        kind: 'income_change',
        id: 'inc',
        op: 'add',
        amount: '500.00',
        frequency: 'monthly',
        fromMonth: { month: 8, year: 2026 },
        label: 'Side gig',
      };
      const delta = await resolveIncomeChange(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      expect(byKey.get('2026-6')?.incomeDelta).toBe('0.00');
      expect(byKey.get('2026-7')?.incomeDelta).toBe('0.00');
      expect(byKey.get('2026-8')?.incomeDelta).toBe('500.00');
      expect(byKey.get('2026-9')?.incomeDelta).toBe('500.00');
      expect(byKey.get('2026-11')?.incomeDelta).toBe('500.00');
    });
  });

  it('add: a quarterly income lands only on its real occurrence months', async () => {
    await withRollback(async (db: DbExecutor) => {
      const lever: SimLever = {
        kind: 'income_change',
        id: 'inc',
        op: 'add',
        amount: '900.00',
        frequency: 'quarterly',
        fromMonth: { month: 6, year: 2026 },
        label: 'Quarterly bonus',
      };
      const delta = await resolveIncomeChange(db, 'user', lever, ctx({ month: 6, year: 2026 }, 9));
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      expect(byKey.get('2026-6')?.incomeDelta).toBe('900.00'); // occ 1
      expect(byKey.get('2026-7')?.incomeDelta).toBe('0.00');
      expect(byKey.get('2026-9')?.incomeDelta).toBe('900.00'); // occ 2 (+3 months)
      expect(byKey.get('2026-12')?.incomeDelta).toBe('900.00'); // occ 3
    });
  });

  it('add: respects toMonth as the end bound', async () => {
    await withRollback(async (db: DbExecutor) => {
      const lever: SimLever = {
        kind: 'income_change',
        id: 'inc',
        op: 'add',
        amount: '100.00',
        frequency: 'monthly',
        fromMonth: { month: 6, year: 2026 },
        toMonth: { month: 7, year: 2026 },
        label: 'Bridge',
      };
      const delta = await resolveIncomeChange(db, 'user', lever, ctx({ month: 6, year: 2026 }, 5));
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      expect(byKey.get('2026-6')?.incomeDelta).toBe('100.00');
      expect(byKey.get('2026-7')?.incomeDelta).toBe('100.00');
      expect(byKey.get('2026-8')?.incomeDelta).toBe('0.00');
    });
  });

  it('add: a backdated fromMonth (months BEFORE the projection start) still lands in-window', async () => {
    await withRollback(async (db: DbExecutor) => {
      // fromMonth is 4 months before the projection's first month (Jun 2026):
      // the occurrence window is anchored at fromMonth, so a too-short horizon
      // would end before the projection and drop every in-window month.
      const lever: SimLever = {
        kind: 'income_change',
        id: 'inc',
        op: 'add',
        amount: '500.00',
        frequency: 'monthly',
        fromMonth: { month: 2, year: 2026 },
        label: 'Backdated side gig',
      };
      const delta = await resolveIncomeChange(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      // EVERY projected month (Jun..Nov 2026) gets the monthly +500.
      for (const m of [6, 7, 8, 9, 10, 11]) {
        expect(byKey.get(`2026-${m}`)?.incomeDelta).toBe('500.00');
      }
    });
  });

  it('end: zeroes income via a negative delta from fromMonth (placeholder amount)', async () => {
    await withRollback(async (db: DbExecutor) => {
      const lever: SimLever = {
        kind: 'income_change',
        id: 'inc',
        op: 'end',
        amount: '700.00',
        frequency: 'monthly',
        fromMonth: { month: 8, year: 2026 },
        label: 'Job ends',
      };
      const delta = await resolveIncomeChange(db, 'user', lever, ctx({ month: 6, year: 2026 }, 5));
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      expect(byKey.get('2026-7')?.incomeDelta).toBe('0.00');
      expect(byKey.get('2026-8')?.incomeDelta).toBe('-700.00');
      expect(byKey.get('2026-10')?.incomeDelta).toBe('-700.00');
    });
  });
});
