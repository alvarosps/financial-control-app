import type { DbExecutor } from '@fc/db';
import { accounts, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { FamilyLoanFlowService } from '../services/family-loan-flow.service.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);

async function seed(db: DbExecutor) {
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `family-loan-router-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Test User',
      passwordHash: 'hashed',
    })
    .returning();

  await db
    .insert(accounts)
    .values({ userId: user.id, name: 'Bank', type: 'checking', currency: 'BRL' });

  const service = new FamilyLoanFlowService(db);
  const { config } = await service.createFamilyLoan(user.id, { personName: 'Celia' });
  const caller = createCaller({ db, userId: user.id, profileCache: createRequestProfileCache(db) });

  return { caller, config };
}

describe('familyLoan.addDiscount', () => {
  it('rejects currentInstallment greater than totalInstallments with BAD_REQUEST', async () => {
    await withRollback(async (db) => {
      const { caller, config } = await seed(db);

      await expect(
        caller.familyLoan.addDiscount({
          configId: config.id,
          description: 'Desconto invalido',
          amount: '50.00',
          date: new Date('2026-06-10'),
          totalInstallments: 6,
          currentInstallment: 7,
          dueDay: 10,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('creates mid-stream discount normalized to startingOccurrence=1', async () => {
    await withRollback(async (db) => {
      const { caller, config } = await seed(db);

      const { schedule } = await caller.familyLoan.addDiscount({
        configId: config.id,
        description: 'Desconto parcelado',
        amount: '50.00',
        date: new Date('2026-06-10'),
        totalInstallments: 6,
        currentInstallment: 3,
        dueDay: 10,
      });

      expect(schedule.startingOccurrence).toBe(1);
      expect(schedule.startDate.toISOString().slice(0, 10)).toBe('2026-04-01');

      const materialized = await caller.scheduled.materialize({ horizonMonths: 12 });
      expect(materialized.invalidSchedules).toEqual([]);
    });
  });
});

describe('familyLoan.editAdjustment', () => {
  it.each([
    {
      name: 'partial installment fields',
      input: { totalInstallments: 12 },
    },
    {
      name: 'single-installment discount',
      input: { totalInstallments: 1, currentInstallment: 1, dueDay: 10 },
    },
    {
      name: 'current installment above total',
      input: { totalInstallments: 6, currentInstallment: 7, dueDay: 10 },
    },
    {
      name: 'date before supported range',
      input: { date: new Date(Date.UTC(2019, 11, 1)) },
    },
    {
      name: 'date after supported range',
      input: { date: new Date(Date.UTC(2101, 0, 1)) },
    },
  ])('rejects $name', async ({ input }) => {
    await withRollback(async (db) => {
      const { caller, config } = await seed(db);
      const { schedule } = await caller.familyLoan.addDiscount({
        configId: config.id,
        description: 'Discount',
        amount: '50.00',
        date: new Date(Date.UTC(2026, 6, 10)),
      });

      await expect(
        caller.familyLoan.editAdjustment({
          scheduleId: schedule.id,
          description: 'Edit',
          amount: '55.00',
          date: new Date(Date.UTC(2026, 6, 10)),
          ...input,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('accepts a complete installment discount payload', async () => {
    await withRollback(async (db) => {
      const { caller, config } = await seed(db);
      const created = await caller.familyLoan.addDiscount({
        configId: config.id,
        description: 'Discount',
        amount: '50.00',
        date: new Date(Date.UTC(2026, 6, 10)),
      });

      await expect(
        caller.familyLoan.editAdjustment({
          scheduleId: created.schedule.id,
          description: 'Installment discount',
          amount: '55.00',
          date: new Date(Date.UTC(2026, 6, 10)),
          totalInstallments: 12,
          currentInstallment: 7,
          dueDay: 10,
        }),
      ).resolves.toMatchObject({ scheduleId: created.schedule.id });
    });
  });
});

describe('familyLoan period inputs', () => {
  it('requires valid month and year for ledger and projection', async () => {
    await withRollback(async (db) => {
      const { caller, config } = await seed(db);

      await expect(
        caller.familyLoan.getLedger({ configId: config.id, month: 0, year: 2026 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.familyLoan.get12MonthProjection({
          configId: config.id,
          month: 7,
          year: 1999,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.familyLoan.getLedger({ configId: config.id, month: 7, year: 2026 }),
      ).resolves.toBeDefined();
      await expect(
        caller.familyLoan.get12MonthProjection({
          configId: config.id,
          month: 7,
          year: 2026,
        }),
      ).resolves.toHaveLength(12);
    });
  });
});
