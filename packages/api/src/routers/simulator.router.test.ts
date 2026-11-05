import type { DbExecutor } from '@fc/db';
import { accounts, scheduledTransactions, transactions, userProfiles } from '@fc/db';
import type { SimScenario } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);

async function seedUser(db: DbExecutor): Promise<string> {
  const [u] = await db
    .insert(userProfiles)
    .values({
      email: `simulator-router-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Test User',
      passwordHash: 'hashed',
    })
    .returning();
  return u.id;
}

// The 6 complete calendar months immediately before the current (partial)
// month — matches the window MonthlyAveragesService derives from `new Date()`,
// which the router uses (no `asOf` input). Mid-month dates land squarely in
// each month.
function recentWindow(): { month: number; year: number }[] {
  const now = new Date();
  const curMonth = now.getUTCMonth() + 1;
  const curYear = now.getUTCFullYear();
  const window: { month: number; year: number }[] = [];
  for (let i = 6; i >= 1; i--) {
    let m = curMonth - i;
    let y = curYear;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    window.push({ month: m, year: y });
  }
  return window;
}

describe('simulator.monthlyAverages', () => {
  it('returns non-zero averages for a user with recent expenses', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [checking] = await db
        .insert(accounts)
        .values({ userId, name: 'Bank', type: 'checking', currency: 'BRL' })
        .returning();
      const [expense] = await db
        .insert(accounts)
        .values({ userId, name: 'Food', type: 'expense', currency: 'BRL' })
        .returning();

      // Steady 1000.00/month "other" expense across each of the 6 window months.
      await db.insert(transactions).values(
        recentWindow().map((w) => ({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal' as const,
          description: 'avulso',
          date: new Date(Date.UTC(w.year, w.month - 1, 15)),
          domainType: null,
        })),
      );

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      const result = await caller.simulator.monthlyAverages();

      expect(result.monthsUsed).toBe(6);
      expect(result.averageMonthlySpend).toBe('1000.00');
      expect(result.byCategory.other).toBe('1000.00');
    });
  });

  it('returns zeros for a user with no data and never sees another user data', async () => {
    await withRollback(async (db) => {
      // User A has a big steady expense across the recent window.
      const userA = await seedUser(db);
      const [checkingA] = await db
        .insert(accounts)
        .values({ userId: userA, name: 'A bank', type: 'checking', currency: 'BRL' })
        .returning();
      const [expenseA] = await db
        .insert(accounts)
        .values({ userId: userA, name: 'A food', type: 'expense', currency: 'BRL' })
        .returning();
      await db.insert(transactions).values(
        recentWindow().map((w) => ({
          userId: userA,
          sourceAccountId: checkingA.id,
          destinationAccountId: expenseA.id,
          amount: '5000.00',
          currency: 'BRL',
          type: 'withdrawal' as const,
          description: 'avulso A',
          date: new Date(Date.UTC(w.year, w.month - 1, 15)),
          domainType: null,
        })),
      );

      // User B has its own account but no transactions.
      const userB = await seedUser(db);
      await db
        .insert(accounts)
        .values({ userId: userB, name: 'B bank', type: 'checking', currency: 'BRL' });

      // The caller is scoped to B's userId (protectedProcedure → ctx.userId),
      // so the query must never read A's rows.
      const caller = createCaller({
        db,
        userId: userB,
        profileCache: createRequestProfileCache(db),
      });

      const result = await caller.simulator.monthlyAverages();

      expect(result.monthsUsed).toBe(0);
      expect(result.averageMonthlySpend).toBe('0.00');
      expect(result.averageNewInstallment).toBe('0.00');
      expect(result.byCategory).toEqual({
        creditCard: '0.00',
        loan: '0.00',
        charge: '0.00',
        other: '0.00',
      });
    });
  });

  it('honors the requested window input', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [checking] = await db
        .insert(accounts)
        .values({ userId, name: 'Bank', type: 'checking', currency: 'BRL' })
        .returning();
      const [expense] = await db
        .insert(accounts)
        .values({ userId, name: 'Food', type: 'expense', currency: 'BRL' })
        .returning();

      // A couple of recent months of data so the query has something to average.
      await db.insert(transactions).values(
        recentWindow().map((w) => ({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal' as const,
          description: 'avulso',
          date: new Date(Date.UTC(w.year, w.month - 1, 15)),
          domainType: null,
        })),
      );

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      const result = await caller.simulator.monthlyAverages({ window: 3 });

      expect(result.window).toBe(3);
    });
  });

  it('rejects an unauthenticated caller (protectedProcedure)', async () => {
    await withRollback(async (db) => {
      const caller = createCaller({
        db,
        userId: null,
        profileCache: createRequestProfileCache(db),
      });

      await expect(caller.simulator.monthlyAverages()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});

describe('simulator.installmentSuggestions', () => {
  it('returns the caller installment schedules mapped to suggestions', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [checking] = await db
        .insert(accounts)
        .values({ userId, name: 'Bank', type: 'checking', currency: 'BRL' })
        .returning();
      const [card] = await db
        .insert(accounts)
        .values({ userId, name: 'Card', type: 'credit_card', currency: 'BRL' })
        .returning();

      await db.insert(scheduledTransactions).values([
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '500.00',
          currency: 'BRL',
          description: 'Notebook',
          frequency: 'monthly',
          startDate: new Date(Date.UTC(2026, 0, 1)),
          totalOccurrences: 12,
          startingOccurrence: 1,
          domainType: 'credit_card_installment',
        },
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '200.00',
          currency: 'BRL',
          description: 'Geladeira',
          frequency: 'monthly',
          startDate: new Date(Date.UTC(2026, 3, 1)),
          totalOccurrences: 5,
          startingOccurrence: 1,
          domainType: 'credit_card_installment',
        },
      ]);

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      const result = await caller.simulator.installmentSuggestions();

      expect(result).toEqual([
        { label: 'Geladeira', amount: '200.00', installments: 5 },
        { label: 'Notebook', amount: '500.00', installments: 12 },
      ]);
    });
  });

  it('is userId-scoped (never sees another user installment schedules)', async () => {
    await withRollback(async (db) => {
      const userA = await seedUser(db);
      const [checkingA] = await db
        .insert(accounts)
        .values({ userId: userA, name: 'A bank', type: 'checking', currency: 'BRL' })
        .returning();
      const [cardA] = await db
        .insert(accounts)
        .values({ userId: userA, name: 'A card', type: 'credit_card', currency: 'BRL' })
        .returning();
      await db.insert(scheduledTransactions).values({
        userId: userA,
        sourceAccountId: checkingA.id,
        destinationAccountId: cardA.id,
        amount: '300.00',
        currency: 'BRL',
        description: 'Celular',
        frequency: 'monthly',
        startDate: new Date(Date.UTC(2026, 0, 1)),
        totalOccurrences: 10,
        startingOccurrence: 1,
        domainType: 'credit_card_installment',
      });

      const userB = await seedUser(db);
      const caller = createCaller({
        db,
        userId: userB,
        profileCache: createRequestProfileCache(db),
      });

      const result = await caller.simulator.installmentSuggestions();

      expect(result).toEqual([]);
    });
  });

  it('rejects an unauthenticated caller (protectedProcedure)', async () => {
    await withRollback(async (db) => {
      const caller = createCaller({
        db,
        userId: null,
        profileCache: createRequestProfileCache(db),
      });

      await expect(caller.simulator.installmentSuggestions()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});

describe('simulator.run', () => {
  it('returns a baseline + simulated projection of the requested horizon with numeric kpis', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [checking] = await db
        .insert(accounts)
        .values({ userId, name: 'Bank', type: 'checking', currency: 'BRL' })
        .returning();
      const [expense] = await db
        .insert(accounts)
        .values({ userId, name: 'Food', type: 'expense', currency: 'BRL' })
        .returning();

      // A little history so the projection has real month buckets to fold.
      await db.insert(transactions).values(
        recentWindow().map((w) => ({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal' as const,
          description: 'avulso',
          date: new Date(Date.UTC(w.year, w.month - 1, 15)),
          domainType: null,
        })),
      );

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      const result = await caller.simulator.run({ horizon: 6, levers: [] });

      expect(result.baseline).toHaveLength(6);
      expect(result.simulated).toHaveLength(6);
      expect(typeof result.kpis.delta).toBe('number');
      expect(typeof result.kpis.endingBaseline).toBe('number');
      expect(typeof result.kpis.endingSimulated).toBe('number');
      // No levers → baseline and simulated paths coincide.
      expect(result.kpis.delta).toBeCloseTo(0, 2);
      expect(result.assumptions.horizon).toBe(6);
      expect(result.assumptions.anchorSource).toBe('wallet_cash');
    });
  });

  it('applies a one_time_event lever so the simulated path diverges from baseline', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [checking] = await db
        .insert(accounts)
        .values({ userId, name: 'Bank', type: 'checking', currency: 'BRL' })
        .returning();
      const [expense] = await db
        .insert(accounts)
        .values({ userId, name: 'Food', type: 'expense', currency: 'BRL' })
        .returning();
      await db.insert(transactions).values(
        recentWindow().map((w) => ({
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal' as const,
          description: 'avulso',
          date: new Date(Date.UTC(w.year, w.month - 1, 15)),
          domainType: null,
        })),
      );

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      // The router uses `new Date()` (no asOf input); the current month is the
      // first projected month, so an event in the current month lands in-horizon.
      const now = new Date();
      const result = await caller.simulator.run({
        horizon: 6,
        levers: [
          {
            kind: 'one_time_event',
            id: 'e1',
            sign: 'outflow',
            amount: '300.00',
            month: { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() },
            label: 'Repair',
          },
        ],
      });

      expect(result.baseline).toHaveLength(6);
      expect(result.simulated).toHaveLength(6);
      // The 300 outflow drags the simulated ending balance below baseline.
      expect(result.kpis.delta).toBeCloseTo(-300, 2);
    });
  });

  it('rejects an unauthenticated caller (protectedProcedure)', async () => {
    await withRollback(async (db) => {
      const caller = createCaller({
        db,
        userId: null,
        profileCache: createRequestProfileCache(db),
      });

      await expect(caller.simulator.run({ horizon: 6, levers: [] })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  it('accepts the max horizon (36) through the router input schema (regression)', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      await db.insert(accounts).values({ userId, name: 'Bank', type: 'checking', currency: 'BRL' });
      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      // Regression: the `run` input schema must allow up to 36 — the UI exposes a
      // 36-month button (HORIZON_OPTIONS) and scenarios persist 1..36. It was
      // capped at max(24), so selecting 36 threw a client-side Zod validation
      // error and the run never executed.
      const result = await caller.simulator.run({ horizon: 36, levers: [] });
      expect(result.baseline).toHaveLength(36);
      expect(result.assumptions.horizon).toBe(36);
    });
  });
});

const minimalScenario: SimScenario = {
  name: 'Plan A',
  horizon: 12,
  levers: [
    {
      kind: 'one_time_event',
      id: 'e1',
      sign: 'outflow',
      amount: '300.00',
      month: { month: 9, year: 2026 },
      label: 'Repair',
    },
  ],
};

describe('simulator scenario CRUD', () => {
  it('save → list → update → duplicate → delete round-trips through the caller', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      // save returns a persisted scenario with an id.
      const saved = await caller.simulator.saveScenario(minimalScenario);
      expect(saved.id).toBeTruthy();
      expect(saved.name).toBe('Plan A');
      expect(saved.parameters).toEqual({
        ...minimalScenario,
        version: 2,
        assumptions: { familyReceiptPercent: 100 },
      });

      // list includes the saved scenario.
      const afterSave = await caller.simulator.listScenarios();
      expect(afterSave.map((s) => s.id)).toContain(saved.id);

      // update mutates name + levers.
      const next: SimScenario = { ...minimalScenario, name: 'Plan A v2', levers: [] };
      const updated = await caller.simulator.updateScenario({ id: saved.id, scenario: next });
      expect(updated.id).toBe(saved.id);
      expect(updated.name).toBe('Plan A v2');
      expect(updated.parameters).toEqual({
        ...next,
        version: 2,
        assumptions: { familyReceiptPercent: 100 },
      });

      // duplicate creates a distinct second scenario.
      const dup = await caller.simulator.duplicateScenario({ id: saved.id });
      expect(dup.id).not.toBe(saved.id);
      const afterDup = await caller.simulator.listScenarios();
      expect(afterDup.map((s) => s.id).sort()).toEqual([saved.id, dup.id].sort());

      // delete removes the original; list no longer includes it.
      await caller.simulator.deleteScenario({ id: saved.id });
      const afterDelete = await caller.simulator.listScenarios();
      const ids = afterDelete.map((s) => s.id);
      expect(ids).not.toContain(saved.id);
      expect(ids).toContain(dup.id);
    });
  });

  it('rejects an unauthenticated caller (saveScenario, protectedProcedure)', async () => {
    await withRollback(async (db) => {
      const caller = createCaller({
        db,
        userId: null,
        profileCache: createRequestProfileCache(db),
      });

      await expect(caller.simulator.saveScenario(minimalScenario)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  it('never leaks another user scenario: update/delete on a foreign id → NOT_FOUND', async () => {
    await withRollback(async (db) => {
      const userA = await seedUser(db);
      const userB = await seedUser(db);

      const callerA = createCaller({
        db,
        userId: userA,
        profileCache: createRequestProfileCache(db),
      });
      const callerB = createCaller({
        db,
        userId: userB,
        profileCache: createRequestProfileCache(db),
      });

      const saved = await callerA.simulator.saveScenario(minimalScenario);

      await expect(
        callerB.simulator.updateScenario({
          id: saved.id,
          scenario: { ...minimalScenario, name: 'hijacked' },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(callerB.simulator.deleteScenario({ id: saved.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      // A's scenario is untouched.
      const aList = await callerA.simulator.listScenarios();
      expect(aList).toHaveLength(1);
      expect(aList[0].name).toBe('Plan A');
    });
  });
});
