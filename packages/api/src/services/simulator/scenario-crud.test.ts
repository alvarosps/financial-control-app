import { simulationScenarios, userProfiles } from '@fc/db';
import type { SimScenario } from '@fc/shared';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../../test/with-rollback.ts';
import { SimulatorService } from '../simulator.service.ts';

async function seedUser(db: Parameters<Parameters<typeof withRollback>[0]>[0], email: string) {
  const [user] = await db
    .insert(userProfiles)
    .values({ email, name: email, passwordHash: 'h' })
    .returning();
  return user;
}

const scenario: SimScenario = {
  name: 'Plan A',
  openingBalanceOverride: '1500.00',
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

describe('SimulatorService scenario CRUD', () => {
  it('save → list round-trips the typed SimScenario in parameters', async () => {
    await withRollback(async (db) => {
      const user = await seedUser(db, 'crud-save@test.com');
      const service = new SimulatorService(db);

      const saved = await service.saveScenario(user.id, scenario);
      expect(saved.name).toBe('Plan A');
      expect(saved.parameters).toEqual({
        ...scenario,
        version: 2,
        assumptions: { familyReceiptPercent: 100 },
      });

      const list = await service.listScenarios(user.id);
      expect(list).toHaveLength(1);
      expect(list[0].parameters).toEqual({
        ...scenario,
        version: 2,
        assumptions: { familyReceiptPercent: 100 },
      });
    });
  });

  it('updateScenario replaces name + parameters', async () => {
    await withRollback(async (db) => {
      const user = await seedUser(db, 'crud-update@test.com');
      const service = new SimulatorService(db);
      const saved = await service.saveScenario(user.id, scenario);

      const next: SimScenario = { ...scenario, name: 'Plan A v2', horizon: 6, levers: [] };
      const updated = await service.updateScenario(user.id, saved.id, next);
      expect(updated.name).toBe('Plan A v2');
      expect(updated.parameters).toEqual({
        ...next,
        version: 2,
        assumptions: { familyReceiptPercent: 100 },
      });

      const [row] = await db
        .select()
        .from(simulationScenarios)
        .where(eq(simulationScenarios.id, saved.id));
      expect(row.parameters).toEqual({
        ...next,
        version: 2,
        assumptions: { familyReceiptPercent: 100 },
      });
    });
  });

  it('duplicateScenario creates a new row with a (copy) name by default', async () => {
    await withRollback(async (db) => {
      const user = await seedUser(db, 'crud-dup@test.com');
      const service = new SimulatorService(db);
      const saved = await service.saveScenario(user.id, scenario);

      const dup = await service.duplicateScenario(user.id, saved.id);
      expect(dup.id).not.toBe(saved.id);
      expect(dup.name).toBe('Plan A (copy)');
      expect(dup.parameters.name).toBe('Plan A (copy)');

      const all = await db
        .select()
        .from(simulationScenarios)
        .where(eq(simulationScenarios.userId, user.id));
      expect(all).toHaveLength(2);
    });
  });

  it('updateScenario / duplicateScenario reject a foreign id with NOT_FOUND', async () => {
    await withRollback(async (db) => {
      const a = await seedUser(db, 'crud-a@test.com');
      const b = await seedUser(db, 'crud-b@test.com');
      const service = new SimulatorService(db);
      const saved = await service.saveScenario(a.id, scenario);

      await expect(service.updateScenario(b.id, saved.id, scenario)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(service.duplicateScenario(b.id, saved.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      const [row] = await db
        .select()
        .from(simulationScenarios)
        .where(and(eq(simulationScenarios.id, saved.id), eq(simulationScenarios.userId, a.id)));
      expect(row.name).toBe('Plan A');
    });
  });
});
