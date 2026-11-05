import type { DbExecutor } from '@fc/db';
import { transactions, userProfiles } from '@fc/db';
import type { SimLever } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { SimulatorService } from './simulator.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'simulator@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();
  const checking = await accountService.create(user.id, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  const expense = await accountService.create(user.id, {
    name: 'Food',
    type: 'expense',
    currency: 'BRL',
  });
  return {
    accountService,
    userId: user.id,
    checkingId: checking.id,
    expenseId: expense.id,
  };
}

describe('SimulatorService.run', () => {
  it('carries the running balance: endingBalance(m) === openingBalance(m+1)', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);
      const service = new SimulatorService(db);

      const result = await service.run(userId, {
        openingBalance: '1000.00',
        horizon: 6,
        levers: [],
        asOf: new Date(2026, 5, 1),
      });

      // No transactions → every month nets 0. With an override the current month
      // (June) is bypassed and the displayed projection starts in July, opening
      // AT the override (1000).
      expect(result.openingBalance).toBe(1000);
      expect(result.cashReadiness).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining(['unreviewed_anchor']),
      });
      expect(result.assumptions.openingBalanceOverridden).toBe(true);
      expect(result.assumptions.anchorSource).toBe('override');
      expect(result.assumptions.currency).toBe('BRL');
      expect(result.assumptions.horizon).toBe(6);
      expect(result.baseline).toHaveLength(6);
      expect(result.simulated).toHaveLength(6);
      expect(result.baseline[0].openingBalance).toBe(1000);

      // The first displayed month is the month AFTER asOf (asOf June → July).
      expect(result.baseline[0].month).toBe(7);
      expect(result.baseline[0].year).toBe(2026);

      for (let i = 0; i < result.baseline.length - 1; i++) {
        expect(result.baseline[i].endingBalance).toBeCloseTo(
          result.baseline[i + 1].openingBalance,
          2,
        );
        expect(result.simulated[i].endingBalance).toBeCloseTo(
          result.simulated[i + 1].openingBalance,
          2,
        );
      }
    });
  });

  it('supports the max horizon (36) without throwing — internal horizon is 37', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);
      const service = new SimulatorService(db);

      // Regression lock: the simulator fetches `horizon + 1` baseline cores, so a
      // user-facing horizon of 36 requests an internal horizon of 37 from
      // BalanceProjectionService (whose cap is 37).
      const result = await service.run(userId, {
        openingBalance: '1000.00',
        horizon: 36,
        levers: [],
        asOf: new Date(2026, 5, 1),
      });

      expect(result.assumptions.horizon).toBe(36);
      expect(result.baseline).toHaveLength(36);
      expect(result.simulated).toHaveLength(36);
      // The current month (June) is bypassed under the override; display starts in July.
      expect(result.baseline[0].month).toBe(7);
      expect(result.baseline[0].year).toBe(2026);
    });
  });

  it('supports the minimum horizon (1) — exactly one displayed month, starting next month', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);
      const service = new SimulatorService(db);

      const result = await service.run(userId, {
        openingBalance: '1000.00',
        horizon: 1,
        levers: [],
        asOf: new Date(2026, 5, 1),
      });

      // Internal horizon is 2 (June folded + July displayed); display shows just
      // July (asOf June + 1).
      expect(result.assumptions.horizon).toBe(1);
      expect(result.baseline).toHaveLength(1);
      expect(result.simulated).toHaveLength(1);
      expect(result.baseline[0].month).toBe(7);
      expect(result.baseline[0].year).toBe(2026);
    });
  });

  it('folds a non-zero current month into the opening under the wallet-cash anchor (no override)', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId, expenseId } = await seed(db);

      // A known CURRENT-month (June) UNPAID charge so June nets ≠ 0. UNPAID is
      // required so currentMonthCore counts it in the unpaid remainder folded into
      // the opening (paid cash would already sit in the wallet-cash anchor).
      const expense = 250;
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checkingId,
        destinationAccountId: expenseId,
        amount: expense.toFixed(2),
        currency: 'BRL',
        type: 'transfer',
        description: 'recurring_bill unpaid',
        date: new Date(Date.UTC(2026, 5, 10)),
        domainType: 'recurring_bill',
        isPaid: false,
      });

      const service = new SimulatorService(db);
      // No `openingBalance` → exercises the wallet-cash anchor (no-override) path.
      const result = await service.run(userId, {
        horizon: 6,
        levers: [],
        asOf: new Date(2026, 5, 1),
      });

      expect(result.assumptions.anchorSource).toBe('wallet_cash');
      expect(result.assumptions.openingBalanceOverridden).toBe(false);

      // June net = unpaidIncome (0) − unpaidExpense (250) = −250. The current month
      // folds the anchor through June, so the first displayed month (July) opens at
      // anchorCash + juneNet = anchorCash − 250.
      expect(result.baseline[0].month).toBe(7);
      expect(result.baseline[0].year).toBe(2026);
      expect(result.baseline[0].openingBalance).toBeCloseTo(result.anchorCash - expense, 2);

      // No displayed row is the current (asOf) month.
      for (const row of result.baseline) {
        expect(row.month === 6 && row.year === 2026).toBe(false);
      }
      for (const row of result.simulated) {
        expect(row.month === 6 && row.year === 2026).toBe(false);
      }
    });
  });

  it('a one-time outflow lowers every simulated ending balance from its month on', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);
      const service = new SimulatorService(db);

      const lever: SimLever = {
        kind: 'one_time_event',
        id: 'e1',
        sign: 'outflow',
        amount: '300.00',
        month: { month: 7, year: 2026 },
        label: 'Repair',
      };

      const result = await service.run(userId, {
        openingBalance: '1000.00',
        horizon: 6,
        levers: [lever],
        asOf: new Date(2026, 5, 1),
      });

      // The current month (June) folds into the opening, so July is now display
      // index 0. The outflow lands on July → every displayed simulated ending
      // (index 0 onward) is 300 lower than baseline.
      expect(result.simulated[0].month).toBe(7);
      for (let i = 0; i < result.simulated.length; i++) {
        const diff = result.baseline[i].endingBalance - result.simulated[i].endingBalance;
        expect(diff).toBeCloseTo(300, 2);
      }
      expect(result.kpis.delta).toBeCloseTo(-300, 2);
      expect(result.simulated[0].events).toEqual([
        { label: 'Repair', amount: 300, sign: 'outflow' },
      ]);
    });
  });

  it('composes average_spend + accumulating installment_growth: per-month sum and the carry', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);
      const service = new SimulatorService(db);

      // Both levers start at the CURRENT month (June, internal index 0). Under an
      // override the current month is BYPASSED (not folded), so June's own
      // 5000+500 is dropped; the displayed July is internal index 1 and still
      // carries every installment that STARTED in June (the obligation persists).
      const firstMonth = { month: 6, year: 2026 };
      const levers: SimLever[] = [
        {
          kind: 'average_spend',
          id: 'avg',
          amount: '5000.00',
          fromMonth: firstMonth,
          label: 'Gasto médio',
        },
        {
          kind: 'installment_growth',
          id: 'inst',
          monthlyAmount: '500.00',
          fromMonth: firstMonth,
          label: 'Parcela nova/mês',
        },
      ];

      const result = await service.run(userId, {
        openingBalance: '1000.00',
        horizon: 6,
        levers,
        asOf: new Date(2026, 5, 1),
      });

      expect(result.baseline).toHaveLength(6);
      expect(result.simulated).toHaveLength(6);
      expect(result.simulated[0].month).toBe(7);

      // Per-month expense delta in INTERNAL-index terms: at internal index k the
      // burden is 5000 + (k+1)×500. June is k=0 (folded), so displayed index j
      // maps to internal index k = j+1 → delta = 5000 + (j+2)×500.
      const internalDelta = (k: number): number => 5000 + (k + 1) * 500;
      for (let j = 0; j < result.simulated.length; j++) {
        const expenseDelta = result.simulated[j].expenses.total - result.baseline[j].expenses.total;
        expect(expenseDelta).toBeCloseTo(internalDelta(j + 1), 2);
      }

      // Under an override the current month is bypassed (not folded), so June's
      // burden is NOT carried into the opening: the cumulative gap at displayed
      // index j is Σ_{k=1..j+1} internalDelta(k) (start at internal index 1 =
      // July). Baseline ending is flat 1000 throughout.
      let cumulative = 0;
      for (let j = 0; j < result.simulated.length; j++) {
        cumulative += internalDelta(j + 1);
        const endingGap = result.baseline[j].endingBalance - result.simulated[j].endingBalance;
        expect(endingGap).toBeCloseTo(cumulative, 2);
      }

      // Sanity: the carry invariant still holds on the simulated path.
      for (let i = 0; i < result.simulated.length - 1; i++) {
        expect(result.simulated[i].endingBalance).toBeCloseTo(
          result.simulated[i + 1].openingBalance,
          2,
        );
      }
    });
  });

  it('composes two overlapping finite installment plans: per-month sum + carry', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);
      const service = new SimulatorService(db);

      // Internal cores cover June 2026 (index 0) .. June 2027 (index 12); June
      // folds into the opening, so displayed index j = internal index j+1.
      // Plan A: 12 parcelas of 500 from Jul 2026 (internal index 1) → internal
      //   indices 1..12 (all within the internal horizon).
      // Plan B: 5 parcelas of 200 from Oct 2026 (internal index 4) → internal
      //   indices 4..8.
      const levers: SimLever[] = [
        {
          kind: 'installment_plan',
          id: 'planA',
          amount: '500.00',
          installments: 12,
          startMonth: { month: 7, year: 2026 },
          label: 'Plano A 12x',
        },
        {
          kind: 'installment_plan',
          id: 'planB',
          amount: '200.00',
          installments: 5,
          startMonth: { month: 10, year: 2026 },
          label: 'Plano B 5x',
        },
      ];

      const result = await service.run(userId, {
        openingBalance: '1000.00',
        horizon: 12,
        levers,
        asOf: new Date(2026, 5, 1),
      });

      expect(result.baseline).toHaveLength(12);
      expect(result.simulated).toHaveLength(12);
      expect(result.simulated[0].month).toBe(7);

      // Per-INTERNAL-index expense delta (simulated − baseline).
      const internalDelta = (k: number): number => {
        let d = 0;
        if (k >= 1 && k <= 12) d += 500; // Plan A
        if (k >= 4 && k <= 8) d += 200; // Plan B
        return d;
      };
      // Displayed index j maps to internal index j+1.
      const displayDelta = (j: number): number => internalDelta(j + 1);

      // Headline cases on the displayed indices:
      //   display 0 (Jul, internal 1) → 500 (A only);
      //   display 3 (Oct, internal 4) → 700 (A+B overlap);
      //   display 8 (Mar, internal 9) → 500 (A only, B ended).
      expect(result.simulated[0].expenses.total - result.baseline[0].expenses.total).toBeCloseTo(
        500,
        2,
      );
      expect(result.simulated[3].expenses.total - result.baseline[3].expenses.total).toBeCloseTo(
        700,
        2,
      );
      expect(result.simulated[8].expenses.total - result.baseline[8].expenses.total).toBeCloseTo(
        500,
        2,
      );

      for (let j = 0; j < result.simulated.length; j++) {
        const delta = result.simulated[j].expenses.total - result.baseline[j].expenses.total;
        expect(delta).toBeCloseTo(displayDelta(j), 2);
      }

      // Plans start in July+ (never the current month), so whether June is folded
      // or bypassed is moot here. The cumulative gap at displayed index j is
      // Σ_{k=1..j+1} internalDelta(k) (internal index 1 = July). Baseline ending
      // is flat 1000 throughout.
      let cumulative = 0;
      for (let j = 0; j < result.simulated.length; j++) {
        cumulative += internalDelta(j + 1);
        const endingGap = result.baseline[j].endingBalance - result.simulated[j].endingBalance;
        expect(endingGap).toBeCloseTo(cumulative, 2);
      }

      // Sanity: the carry invariant still holds on the simulated path.
      for (let i = 0; i < result.simulated.length - 1; i++) {
        expect(result.simulated[i].endingBalance).toBeCloseTo(
          result.simulated[i + 1].openingBalance,
          2,
        );
      }
    });
  });

  it('uses the wallet-cash anchor when no override is given', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);
      const service = new SimulatorService(db);
      const result = await service.run(userId, {
        horizon: 3,
        levers: [],
        asOf: new Date(2026, 5, 1),
      });
      expect(result.assumptions.anchorSource).toBe('wallet_cash');
      expect(result.assumptions.openingBalanceOverridden).toBe(false);
      // No data: every month nets 0, so the current month folds the anchor
      // through unchanged → the projection opening equals the anchor cash, and
      // openingNow (the assumed current cash) equals it too.
      expect(result.openingBalance).toBe(result.anchorCash);
      expect(result.kpis.openingNow).toBe(result.anchorCash);
    });
  });

  it('an override anchors the first displayed month directly and bypasses the current month', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId, expenseId } = await seed(db);

      // A CURRENT-month (June) UNPAID charge. With an override it must NOT affect
      // the projection: the override IS the balance at the first displayed
      // month's day 1, and only inflows/outflows from the next month on count.
      const expense = 250;
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checkingId,
        destinationAccountId: expenseId,
        amount: expense.toFixed(2),
        currency: 'BRL',
        type: 'transfer',
        description: 'recurring_bill unpaid',
        date: new Date(Date.UTC(2026, 5, 10)),
        domainType: 'recurring_bill',
        isPaid: false,
      });

      const service = new SimulatorService(db);
      const result = await service.run(userId, {
        openingBalance: '1000.00',
        horizon: 6,
        levers: [],
        asOf: new Date(2026, 5, 1),
      });

      // First displayed month is July (asOf June + 1), opening AT the override
      // (1000) — June's 250 charge is bypassed, NOT subtracted.
      expect(result.baseline[0].month).toBe(7);
      expect(result.baseline[0].year).toBe(2026);
      expect(result.baseline[0].openingBalance).toBe(1000);
      expect(result.openingBalance).toBe(1000);

      // openingNow ("Saldo atual") is the real wallet-cash anchor, not the override.
      expect(result.kpis.openingNow).toBe(result.anchorCash);

      // No displayed row is the current (asOf) month.
      for (const row of result.baseline) {
        expect(row.month === 6 && row.year === 2026).toBe(false);
      }
      for (const row of result.simulated) {
        expect(row.month === 6 && row.year === 2026).toBe(false);
      }
    });
  });

  it('under an override, a current-month lever is bypassed (the override is the next-month opening)', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);
      const service = new SimulatorService(db);

      const amount = 400;
      const lever: SimLever = {
        kind: 'one_time_event',
        id: 'cur',
        sign: 'outflow',
        amount: amount.toFixed(2),
        month: { month: 6, year: 2026 }, // the asOf (current) month
        label: 'Current-month outflow',
      };

      const result = await service.run(userId, {
        openingBalance: '1000.00',
        horizon: 6,
        levers: [lever],
        asOf: new Date(2026, 5, 1),
      });

      // The lever lands on June, which is bypassed under an override — it neither
      // appears as a displayed row nor shifts the opening. simulated == baseline.
      for (const row of result.simulated) {
        expect(row.events).toEqual([]);
        expect(row.month === 6 && row.year === 2026).toBe(false);
      }
      expect(result.simulated[0].openingBalance).toBe(1000);
      expect(result.baseline[0].openingBalance).toBe(1000);
      expect(result.kpis.delta).toBeCloseTo(0, 2);
    });
  });

  it('under the wallet-cash anchor, a current-month lever folds into the opening', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);
      const service = new SimulatorService(db);

      const amount = 400;
      const lever: SimLever = {
        kind: 'one_time_event',
        id: 'cur',
        sign: 'outflow',
        amount: amount.toFixed(2),
        month: { month: 6, year: 2026 }, // the asOf (current) month
        label: 'Current-month outflow',
      };

      // No override → wallet-cash path: the current month is folded from the real
      // anchor, so a June lever folds into the first displayed month's opening.
      const result = await service.run(userId, {
        horizon: 6,
        levers: [lever],
        asOf: new Date(2026, 5, 1),
      });

      // The lever lands on June (folded, not displayed) — no displayed row carries
      // the event, and none is the current month.
      for (const row of result.simulated) {
        expect(row.events).toEqual([]);
        expect(row.month === 6 && row.year === 2026).toBe(false);
      }

      // It folded into the simulated opening: the first simulated month opens
      // `amount` lower than the baseline's first month (baseline has no lever).
      expect(result.baseline[0].openingBalance - result.simulated[0].openingBalance).toBeCloseTo(
        amount,
        2,
      );
    });
  });
});
