/**
 * Cross-user IDOR regression suite for every service whose writes were
 * flagged by the Front G audit. Each test attempts to mutate user A's data
 * as user B and asserts (a) the call rejects, and (b) the underlying row is
 * unchanged in the DB.
 *
 * Keep tests small and one-concern per service — service-specific functional
 * tests live in their own *.service.test.ts files.
 */
import type { DbExecutor } from '@fc/db';
import {
  accounts,
  categories,
  scheduledTransactions,
  simulationScenarios,
  userProfiles,
} from '@fc/db';
import type { SimScenario } from '@fc/shared';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { CategoryService } from './category.service.ts';
import { ScheduledService } from './scheduled.service.ts';
import { SimulatorService } from './simulator.service.ts';

async function seedUser(db: DbExecutor, email: string) {
  const [user] = await db
    .insert(userProfiles)
    .values({ email, name: email, passwordHash: 'hashed' })
    .returning();
  return user;
}

describe('IDOR sweep — cross-user writes on tenant-scoped tables', () => {
  describe('AccountService', () => {
    it("rejects update of another user's account", async () => {
      await withRollback(async (db) => {
        const a = await seedUser(db, 'idor-acc-a@test.com');
        const b = await seedUser(db, 'idor-acc-b@test.com');
        const svc = new AccountService(db);
        const acc = await svc.create(a.id, { name: 'A', type: 'checking', currency: 'BRL' });

        await expect(svc.update(b.id, acc.id, { name: 'hijacked' })).rejects.toMatchObject({
          name: 'NotFoundError',
        });

        const [after] = await db.select().from(accounts).where(eq(accounts.id, acc.id));
        expect(after.name).toBe('A');
      });
    });

    it("rejects deactivate of another user's account", async () => {
      await withRollback(async (db) => {
        const a = await seedUser(db, 'idor-acc-a2@test.com');
        const b = await seedUser(db, 'idor-acc-b2@test.com');
        const svc = new AccountService(db);
        const acc = await svc.create(a.id, { name: 'A', type: 'checking', currency: 'BRL' });

        await expect(svc.deactivate(b.id, acc.id)).rejects.toMatchObject({
          name: 'NotFoundError',
        });

        const [after] = await db.select().from(accounts).where(eq(accounts.id, acc.id));
        expect(after.isActive).toBe(true);
      });
    });
  });

  describe('CategoryService', () => {
    it("rejects update of another user's category", async () => {
      await withRollback(async (db) => {
        const a = await seedUser(db, 'idor-cat-a@test.com');
        const b = await seedUser(db, 'idor-cat-b@test.com');
        const svc = new CategoryService(db);
        const cat = await svc.create(a.id, { name: 'Mine', type: 'expense' });

        await expect(svc.update(b.id, cat.id, { name: 'hijacked' })).rejects.toMatchObject({
          name: 'NotFoundError',
        });

        const [after] = await db.select().from(categories).where(eq(categories.id, cat.id));
        expect(after.name).toBe('Mine');
      });
    });

    it("rejects delete of another user's category", async () => {
      await withRollback(async (db) => {
        const a = await seedUser(db, 'idor-cat-a2@test.com');
        const b = await seedUser(db, 'idor-cat-b2@test.com');
        const svc = new CategoryService(db);
        const cat = await svc.create(a.id, { name: 'Mine', type: 'expense' });

        await expect(svc.delete(b.id, cat.id)).rejects.toMatchObject({ name: 'NotFoundError' });

        const [after] = await db.select().from(categories).where(eq(categories.id, cat.id));
        expect(after).toBeDefined();
      });
    });
  });

  describe('ScheduledService', () => {
    it("rejects update of another user's schedule", async () => {
      await withRollback(async (db) => {
        const a = await seedUser(db, 'idor-sch-a@test.com');
        const b = await seedUser(db, 'idor-sch-b@test.com');
        const accSvc = new AccountService(db);
        const src = await accSvc.create(a.id, { name: 'Src', type: 'expense', currency: 'BRL' });
        const dst = await accSvc.create(a.id, { name: 'Dst', type: 'checking', currency: 'BRL' });
        const svc = new ScheduledService(db);
        const sch = await svc.create(a.id, {
          sourceAccountId: src.id,
          destinationAccountId: dst.id,
          amount: '10.00',
          description: 'Mine',
          frequency: 'monthly',
          startDate: new Date('2026-03-01'),
        });

        await expect(svc.update(b.id, sch.id, { description: 'hijacked' })).rejects.toMatchObject({
          name: 'NotFoundError',
        });

        const [after] = await db
          .select()
          .from(scheduledTransactions)
          .where(eq(scheduledTransactions.id, sch.id));
        expect(after.description).toBe('Mine');
      });
    });

    it("rejects deactivate of another user's schedule", async () => {
      await withRollback(async (db) => {
        const a = await seedUser(db, 'idor-sch-a2@test.com');
        const b = await seedUser(db, 'idor-sch-b2@test.com');
        const accSvc = new AccountService(db);
        const src = await accSvc.create(a.id, { name: 'Src', type: 'expense', currency: 'BRL' });
        const dst = await accSvc.create(a.id, { name: 'Dst', type: 'checking', currency: 'BRL' });
        const svc = new ScheduledService(db);
        const sch = await svc.create(a.id, {
          sourceAccountId: src.id,
          destinationAccountId: dst.id,
          amount: '10.00',
          description: 'Mine',
          frequency: 'monthly',
          startDate: new Date('2026-03-01'),
        });

        await expect(svc.deactivate(b.id, sch.id)).rejects.toMatchObject({
          name: 'NotFoundError',
        });

        const [after] = await db
          .select()
          .from(scheduledTransactions)
          .where(eq(scheduledTransactions.id, sch.id));
        expect(after.isActive).toBe(true);
      });
    });
  });

  describe('SimulatorService', () => {
    const scenario: SimScenario = {
      name: 'Mine',
      horizon: 12,
      levers: [],
    };

    it("rejects delete of another user's scenario", async () => {
      await withRollback(async (db) => {
        const a = await seedUser(db, 'idor-sim-a@test.com');
        const b = await seedUser(db, 'idor-sim-b@test.com');
        const svc = new SimulatorService(db);
        const created = await svc.saveScenario(a.id, scenario);

        await expect(svc.deleteScenario(b.id, created.id)).rejects.toMatchObject({
          name: 'TRPCError',
          code: 'NOT_FOUND',
        });

        const [after] = await db
          .select()
          .from(simulationScenarios)
          .where(and(eq(simulationScenarios.id, created.id), eq(simulationScenarios.userId, a.id)));
        expect(after).toBeDefined();
      });
    });

    it("rejects update of another user's scenario", async () => {
      await withRollback(async (db) => {
        const a = await seedUser(db, 'idor-sim-a2@test.com');
        const b = await seedUser(db, 'idor-sim-b2@test.com');
        const svc = new SimulatorService(db);
        const created = await svc.saveScenario(a.id, scenario);

        await expect(
          svc.updateScenario(b.id, created.id, { ...scenario, name: 'hijacked' }),
        ).rejects.toMatchObject({ name: 'TRPCError', code: 'NOT_FOUND' });

        const [after] = await db
          .select()
          .from(simulationScenarios)
          .where(eq(simulationScenarios.id, created.id));
        expect(after.name).toBe('Mine');
      });
    });

    it("rejects duplicate of another user's scenario", async () => {
      await withRollback(async (db) => {
        const a = await seedUser(db, 'idor-sim-a3@test.com');
        const b = await seedUser(db, 'idor-sim-b3@test.com');
        const svc = new SimulatorService(db);
        const created = await svc.saveScenario(a.id, scenario);

        await expect(svc.duplicateScenario(b.id, created.id)).rejects.toMatchObject({
          name: 'TRPCError',
          code: 'NOT_FOUND',
        });

        const all = await db
          .select()
          .from(simulationScenarios)
          .where(eq(simulationScenarios.userId, a.id));
        expect(all).toHaveLength(1);
      });
    });
  });
});
