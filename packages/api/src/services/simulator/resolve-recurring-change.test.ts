import type { DbExecutor } from '@fc/db';
import { fxRates, scheduledTransactions, userProfiles } from '@fc/db';
import type { MonthRef, SimLever } from '@fc/shared';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../../test/with-rollback.ts';
import { AccountService } from '../account.service.ts';
import { ScheduledService } from '../scheduled.service.ts';
import { resolveRecurringChange } from './resolve-recurring-change.ts';

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

describe('resolveRecurringChange', () => {
  it('cancel: places each real occurrence of MULTIPLE schedules as a negative expense (FX-converted)', async () => {
    await withRollback(async (db: DbExecutor) => {
      const accountService = new AccountService(db);
      const scheduledService = new ScheduledService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'rec@test.com', name: 'R', passwordHash: 'h' })
        .returning();
      const checking = await accountService.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const expense = await accountService.create(user.id, {
        name: 'Subs',
        type: 'expense',
        currency: 'BRL',
      });

      // Monthly 100 BRL subscription from Jun 2026.
      const brl = await scheduledService.create(user.id, {
        sourceAccountId: expense.id,
        destinationAccountId: checking.id,
        amount: '100.00',
        description: 'Spotify',
        frequency: 'monthly',
        startDate: new Date(2026, 5, 1),
        dueDay: 1,
      });

      // Annual USD subscription from Jun 2026 — needs FX. Store currency=USD and a
      // per-tx rate via the schedule's currency column + a config rate of 5.00.
      const usd = await scheduledService.create(user.id, {
        sourceAccountId: expense.id,
        destinationAccountId: checking.id,
        amount: '20.00',
        description: 'USD annual',
        frequency: 'annual',
        startDate: new Date(2026, 5, 1),
        dueDay: 1,
      });
      // Mark the second schedule as USD with a 5.00 rate stored in notes-as-rate convention.
      await db
        .update(scheduledTransactions)
        .set({ currency: 'USD' })
        .where(eq(scheduledTransactions.id, usd.id));

      const lever: SimLever = {
        kind: 'recurring_change',
        id: 'rc',
        op: 'cancel',
        scheduledTransactionId: brl.id,
        label: 'Cancel subs',
      };

      const delta = await resolveRecurringChange(
        db,
        user.id,
        lever,
        ctx({ month: 6, year: 2026 }, 4),
      );
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      // The BRL monthly schedule: -100 each month it occurs.
      expect(byKey.get('2026-6')?.expenseDelta).toBe('-100.00');
      expect(byKey.get('2026-7')?.expenseDelta).toBe('-100.00');
      expect(byKey.get('2026-9')?.expenseDelta).toBe('-100.00');
    });
  });

  it('cancel: a NON-BRL (USD) schedule resolves WITHOUT throwing and yields a finite reduction', async () => {
    await withRollback(async (db: DbExecutor) => {
      await db
        .delete(fxRates)
        .where(and(eq(fxRates.baseCurrency, 'USD'), eq(fxRates.quoteCurrency, 'BRL')));
      const accountService = new AccountService(db);
      const scheduledService = new ScheduledService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'recusd@test.com', name: 'R', passwordHash: 'h' })
        .returning();
      const checking = await accountService.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const expense = await accountService.create(user.id, {
        name: 'Subs',
        type: 'expense',
        currency: 'BRL',
      });

      // Monthly USD subscription from Jun 2026 — NO income_source_config rate and
      // NO global fx_rates cache for this account, so the BRL-only fallback applies.
      const usd = await scheduledService.create(user.id, {
        sourceAccountId: expense.id,
        destinationAccountId: checking.id,
        amount: '20.00',
        description: 'USD monthly',
        frequency: 'monthly',
        startDate: new Date(2026, 5, 1),
        dueDay: 1,
      });
      await db
        .update(scheduledTransactions)
        .set({ currency: 'USD' })
        .where(eq(scheduledTransactions.id, usd.id));

      const lever: SimLever = {
        kind: 'recurring_change',
        id: 'rc',
        op: 'cancel',
        scheduledTransactionId: usd.id,
        label: 'Cancel USD sub',
      };

      // The fix: a non-BRL cancel must NOT throw "No valid exchange rate".
      const delta = await resolveRecurringChange(
        db,
        user.id,
        lever,
        ctx({ month: 6, year: 2026 }, 4),
      );
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      // BRL-only fallback: the stored 20.00 is treated as already-BRL (no rate
      // source exists), so each monthly occurrence subtracts a finite -20.00 —
      // never NaN, never a thrown 500.
      const jun = byKey.get('2026-6')?.expenseDelta;
      expect(jun).toBe('-20.00');
      expect(Number.isFinite(Number(jun))).toBe(true);
      expect(byKey.get('2026-7')?.expenseDelta).toBe('-20.00');
    });
  });

  it('cancel: a schedule whose startDate is ~12 months BEFORE the projection reduces EVERY projected month', async () => {
    await withRollback(async (db: DbExecutor) => {
      const accountService = new AccountService(db);
      const scheduledService = new ScheduledService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'recback@test.com', name: 'R', passwordHash: 'h' })
        .returning();
      const checking = await accountService.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const expense = await accountService.create(user.id, {
        name: 'Subs',
        type: 'expense',
        currency: 'BRL',
      });

      // A monthly 80 BRL subscription whose REAL startDate is Jun 2025 — twelve
      // months before the projection's first month (Jun 2026). The occurrence
      // window is anchored at startDate, so a horizon sized from the projection
      // start would end before the projection and the cancel would silently do
      // nothing. The fix sizes the window to reach the projection's last month.
      const brl = await scheduledService.create(user.id, {
        sourceAccountId: expense.id,
        destinationAccountId: checking.id,
        amount: '80.00',
        description: 'Old subscription',
        frequency: 'monthly',
        startDate: new Date(2025, 5, 1),
        dueDay: 1,
      });

      const lever: SimLever = {
        kind: 'recurring_change',
        id: 'rc',
        op: 'cancel',
        scheduledTransactionId: brl.id,
        label: 'Cancel old sub',
      };

      const delta = await resolveRecurringChange(
        db,
        user.id,
        lever,
        ctx({ month: 6, year: 2026 }, 6),
      );
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      // EVERY projected month (Jun..Nov 2026) is reduced by -80 — never 0.
      for (const m of [6, 7, 8, 9, 10, 11]) {
        expect(byKey.get(`2026-${m}`)?.expenseDelta).toBe('-80.00');
      }
    });
  });

  it('add: a backdated startMonth (months BEFORE the projection start) still lands in-window', async () => {
    await withRollback(async (db: DbExecutor) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'recaddback@test.com', name: 'R', passwordHash: 'h' })
        .returning();
      const lever: SimLever = {
        kind: 'recurring_change',
        id: 'rc',
        op: 'add',
        amount: '40.00',
        frequency: 'monthly',
        startMonth: { month: 1, year: 2026 },
        label: 'Backdated charge',
      };
      const delta = await resolveRecurringChange(
        db,
        user.id,
        lever,
        ctx({ month: 6, year: 2026 }, 6),
      );
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      for (const m of [6, 7, 8, 9, 10, 11]) {
        expect(byKey.get(`2026-${m}`)?.expenseDelta).toBe('40.00');
      }
    });
  });

  it('add: places a new synthetic recurrence at a non-monthly frequency', async () => {
    await withRollback(async (db: DbExecutor) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'recadd@test.com', name: 'R', passwordHash: 'h' })
        .returning();
      const lever: SimLever = {
        kind: 'recurring_change',
        id: 'rc',
        op: 'add',
        amount: '60.00',
        frequency: 'quarterly',
        startMonth: { month: 6, year: 2026 },
        label: 'New quarterly charge',
      };
      const delta = await resolveRecurringChange(
        db,
        user.id,
        lever,
        ctx({ month: 6, year: 2026 }, 9),
      );
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      expect(byKey.get('2026-6')?.expenseDelta).toBe('60.00'); // occ 1
      expect(byKey.get('2026-7')?.expenseDelta).toBe('0.00');
      expect(byKey.get('2026-9')?.expenseDelta).toBe('60.00'); // occ 2
      expect(byKey.get('2026-12')?.expenseDelta).toBe('60.00'); // occ 3
    });
  });
});
