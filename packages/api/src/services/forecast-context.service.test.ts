import {
  accounts,
  incomeSourceConfigs,
  simulationScenarios,
  transactions,
  userProfiles,
} from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { ForecastContextService } from './forecast-context.service.ts';
import { SimulatorService } from './simulator.service.ts';

describe('forecast assumptions', () => {
  it('allocates a receipt to the oldest debt, projects only the remainder and never settles it', async () => {
    await withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'forecast@test.com', name: 'Test', passwordHash: 'h' })
        .returning();
      const wallet = await new AccountService(db).create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2026-01-01T00:00:00Z') })
        .where(eq(accounts.id, wallet.id));
      const flow = new FamilyLoanFlowService(db);
      const { config } = await flow.createFamilyLoan(user.id, { personName: 'Family' });
      for (const date of ['2026-05-05', '2026-06-05', '2026-07-05']) {
        await flow.addOneTimeCharge(user.id, {
          configId: config.id,
          description: 'Due',
          amount: '100.00',
          date: new Date(date),
        });
      }
      await flow.recordPayment(user.id, {
        configId: config.id,
        amount: '150.00',
        date: new Date('2026-06-10'),
        walletAccountId: wallet.id,
      });
      const asOf = new Date('2026-06-16T15:00:00Z');
      const context = await new ForecastContextService(db).getMonths(
        user.id,
        { month: 6, year: 2026 },
        2,
        asOf,
      );
      expect(context[0]).toMatchObject({
        familyOwed: 100,
        familyAllocated: 50,
        familyRemaining: 50,
      });
      expect(context[1]).toMatchObject({
        familyOwed: 100,
        familyAllocated: 0,
        familyRemaining: 100,
      });
      const before = await db.select().from(transactions).where(eq(transactions.userId, user.id));
      const simulator = new SimulatorService(db);
      const base = await simulator.run(user.id, { horizon: 1, levers: [], asOf });
      expect(base.openingBalance).toBe(200); // 150 received + 50 still expected in June
      expect(base.baseline[0].income.familyLoan).toBe(100);
      const zero = await simulator.run(user.id, {
        horizon: 1,
        levers: [],
        assumptions: { familyReceiptPercent: 0 },
        asOf,
      });
      expect(zero.openingBalance).toBe(150);
      expect(zero.simulated[0].income.total).toBe(0);
      const half = await simulator.run(user.id, {
        horizon: 1,
        levers: [],
        assumptions: { familyReceiptPercent: 50 },
        asOf,
      });
      expect(half.openingBalance).toBe(175);
      expect(half.simulated[0].income.total).toBe(50);
      expect(await db.select().from(transactions).where(eq(transactions.userId, user.id))).toEqual(
        before,
      );
    });
  });

  it('keeps absent FX incomplete and applies a scenario rate with the fee only to forecasts', async () => {
    await withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'forecast-fx@test.com', name: 'Test', passwordHash: 'h' })
        .returning();
      const service = new AccountService(db);
      const wallet = await service.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const revenue = await service.create(user.id, {
        name: 'USD',
        type: 'revenue',
        currency: 'USD',
      });
      await db.insert(incomeSourceConfigs).values({
        accountId: revenue.id,
        frequency: 'monthly',
        category: 'salary_pj',
        conversionFeePercent: '1.00',
      });
      await db.insert(transactions).values({
        userId: user.id,
        sourceAccountId: revenue.id,
        destinationAccountId: wallet.id,
        amount: '1000.00',
        currency: 'USD',
        type: 'deposit',
        description: 'Forecast',
        date: new Date('2026-07-05'),
        domainType: 'income_pj',
      });
      const result = await new SimulatorService(db).run(user.id, {
        horizon: 1,
        levers: [],
        assumptions: { familyReceiptPercent: 100, exchangeRates: { USD: '5.000000' } },
        asOf: new Date('2026-06-16T15:00:00Z'),
      });
      expect(result.forecast[1].incomeUnavailableCount).toBe(1);
      expect(result.baseline[0].income.base).toBe(0);
      expect(result.simulated[0].income.total).toBe(4950);
      expect(result.assumptions.exchangeRates).toEqual({ USD: '5.000000' });
    });
  });

  it('reads a v1 saved scenario as v2 without rewriting the stored document', async () => {
    await withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'forecast-version@test.com', name: 'Test', passwordHash: 'h' })
        .returning();
      const legacy = { name: 'Old', horizon: 12, levers: [] };
      const [row] = await db
        .insert(simulationScenarios)
        .values({ userId: user.id, name: 'Old', type: 'scenario', parameters: legacy })
        .returning();
      const [scenario] = await new SimulatorService(db).listScenarios(user.id);
      expect(scenario.parameters).toMatchObject({
        version: 2,
        assumptions: { familyReceiptPercent: 100 },
      });
      const [stored] = await db
        .select()
        .from(simulationScenarios)
        .where(eq(simulationScenarios.id, row.id));
      expect(stored.parameters).toEqual(legacy);
    });
  });
});
