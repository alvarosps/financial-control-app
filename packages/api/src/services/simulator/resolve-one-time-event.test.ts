import type { DbExecutor } from '@fc/db';
import type { MonthRef, SimLever } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../../test/with-rollback.ts';
import { resolveOneTimeEvent } from './resolve-one-time-event.ts';

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

describe('resolveOneTimeEvent', () => {
  it('inflow: single positive income delta + inflow event in the chosen month', async () => {
    await withRollback(async (db: DbExecutor) => {
      const lever: SimLever = {
        kind: 'one_time_event',
        id: 'e1',
        sign: 'inflow',
        amount: '2500.00',
        month: { month: 8, year: 2026 },
        label: 'Bonus',
      };
      const delta = await resolveOneTimeEvent(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      expect(byKey.get('2026-8')?.incomeDelta).toBe('2500.00');
      expect(byKey.get('2026-8')?.expenseDelta).toBe('0.00');
      expect(byKey.get('2026-7')?.incomeDelta).toBe('0.00');
      expect(delta.events).toEqual([
        { month: 8, year: 2026, label: 'Bonus', sign: 'inflow', amount: '2500.00' },
      ]);
    });
  });

  it('outflow: single positive expense delta + outflow event', async () => {
    await withRollback(async (db: DbExecutor) => {
      const lever: SimLever = {
        kind: 'one_time_event',
        id: 'e2',
        sign: 'outflow',
        amount: '800.00',
        month: { month: 7, year: 2026 },
        label: 'Repair',
      };
      const delta = await resolveOneTimeEvent(db, 'user', lever, ctx({ month: 6, year: 2026 }, 6));
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      expect(byKey.get('2026-7')?.expenseDelta).toBe('800.00');
      expect(byKey.get('2026-7')?.incomeDelta).toBe('0.00');
      expect(delta.events[0]).toMatchObject({
        month: 7,
        year: 2026,
        sign: 'outflow',
        amount: '800.00',
      });
    });
  });
});
