import type { DbExecutor } from '@fc/db';
import {
  accounts,
  fxRates,
  incomeSourceConfigs,
  scheduledTransactions,
  userProfiles,
} from '@fc/db';
import { and, desc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger.ts';
import { withRollback } from '../test/with-rollback.ts';
import { type FxFetcher, FxRateService } from './fx-rate.service.ts';

const NOW = new Date('2026-06-03T12:00:00');
const TODAY = '2026-06-03';
const YESTERDAY = '2026-06-02';

const TEST_USER = {
  email: 'fx-rate-test@example.com',
  name: 'FX Rate Test User',
  passwordHash: 'hashed',
};

/**
 * Seed a USD income source: a revenue account, its income_source_config with a
 * stale exchange_rate, and a USD scheduled_transaction (source = revenue
 * account). Returns the source account id whose config should be synced.
 */
async function seedUsdIncomeSource(db: DbExecutor, staleRate = '1.000000') {
  await db
    .delete(fxRates)
    .where(and(eq(fxRates.baseCurrency, 'USD'), eq(fxRates.quoteCurrency, 'BRL')));
  const [user] = await db.insert(userProfiles).values(TEST_USER).returning();

  const [revenue] = await db
    .insert(accounts)
    .values({ userId: user.id, name: 'USD Salary', type: 'revenue', currency: 'USD' })
    .returning();

  const [checking] = await db
    .insert(accounts)
    .values({ userId: user.id, name: 'Checking', type: 'checking', currency: 'BRL' })
    .returning();

  await db.insert(incomeSourceConfigs).values({
    accountId: revenue.id,
    frequency: 'monthly',
    category: 'salary_pj',
    exchangeRate: staleRate,
  });

  await db.insert(scheduledTransactions).values({
    userId: user.id,
    sourceAccountId: revenue.id,
    destinationAccountId: checking.id,
    amount: '1000.00',
    currency: 'USD',
    description: 'USD Salary',
    frequency: 'monthly',
    startDate: new Date('2026-01-01'),
  });

  return { userId: user.id, sourceAccountId: revenue.id };
}

async function readUsdBrl(db: DbExecutor) {
  const [row] = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.baseCurrency, 'USD'), eq(fxRates.quoteCurrency, 'BRL')))
    .orderBy(desc(fxRates.fetchedOn))
    .limit(1);
  return row ?? null;
}

async function readExchangeRate(db: DbExecutor, accountId: string) {
  const [config] = await db
    .select({ exchangeRate: incomeSourceConfigs.exchangeRate })
    .from(incomeSourceConfigs)
    .where(eq(incomeSourceConfigs.accountId, accountId));
  return config?.exchangeRate ?? null;
}

describe('FxRateService', () => {
  it('fetches + upserts when no row exists and syncs USD income exchange_rate', async () => {
    await withRollback(async (db) => {
      const { sourceAccountId } = await seedUsdIncomeSource(db);

      const fetcher: FxFetcher = vi
        .fn()
        .mockResolvedValue({ rate: '5.0572', source: 'awesomeapi' });
      const service = new FxRateService(db, fetcher);

      await service.refreshIfStale(NOW);

      expect(fetcher).toHaveBeenCalledOnce();

      const row = await readUsdBrl(db);
      expect(row).not.toBeNull();
      expect(row?.fetchedOn).toBe(TODAY);
      expect(row?.source).toBe('awesomeapi');
      expect(Number(row?.rate)).toBe(5.0572);

      const synced = await readExchangeRate(db, sourceAccountId);
      expect(Number(synced)).toBe(5.0572);
    });
  });

  it('is a no-op on the same day (does not call the fetcher, row unchanged)', async () => {
    await withRollback(async (db) => {
      await seedUsdIncomeSource(db);
      await db.insert(fxRates).values({
        baseCurrency: 'USD',
        quoteCurrency: 'BRL',
        rate: '4.9000',
        fetchedOn: TODAY,
        fetchedAt: NOW,
        source: 'seed',
      });

      const fetcher: FxFetcher = vi.fn(async () => {
        throw new Error('fetcher must not be called on the same day');
      });
      const service = new FxRateService(db, fetcher);

      await service.refreshIfStale(NOW);

      expect(fetcher).not.toHaveBeenCalled();

      const row = await readUsdBrl(db);
      expect(row?.fetchedOn).toBe(TODAY);
      expect(row?.source).toBe('seed');
      expect(Number(row?.rate)).toBe(4.9);
    });
  });

  it('re-fetches when the stored rate is from a previous day', async () => {
    await withRollback(async (db) => {
      const { sourceAccountId } = await seedUsdIncomeSource(db);
      await db.insert(fxRates).values({
        baseCurrency: 'USD',
        quoteCurrency: 'BRL',
        rate: '4.9000',
        fetchedOn: YESTERDAY,
        fetchedAt: new Date('2026-06-02T12:00:00'),
        source: 'seed',
      });

      const fetcher: FxFetcher = vi
        .fn()
        .mockResolvedValue({ rate: '5.1234', source: 'awesomeapi' });
      const service = new FxRateService(db, fetcher);

      await service.refreshIfStale(NOW);

      expect(fetcher).toHaveBeenCalledOnce();

      const row = await readUsdBrl(db);
      expect(row?.fetchedOn).toBe(TODAY);
      expect(Number(row?.rate)).toBe(5.1234);
      expect(row?.source).toBe('awesomeapi');

      const synced = await readExchangeRate(db, sourceAccountId);
      expect(Number(synced)).toBe(5.1234);
    });
  });

  it('preserves history: a new day INSERTs a new row instead of overwriting', async () => {
    await withRollback(async (db) => {
      await seedUsdIncomeSource(db);
      await db.insert(fxRates).values({
        baseCurrency: 'USD',
        quoteCurrency: 'BRL',
        rate: '4.9000',
        fetchedOn: YESTERDAY,
        fetchedAt: new Date('2026-06-02T12:00:00'),
        source: 'seed',
      });

      const fetcher: FxFetcher = vi
        .fn()
        .mockResolvedValue({ rate: '5.1234', source: 'awesomeapi' });
      const service = new FxRateService(db, fetcher);

      await service.refreshIfStale(NOW);

      const rows = await db
        .select()
        .from(fxRates)
        .where(and(eq(fxRates.baseCurrency, 'USD'), eq(fxRates.quoteCurrency, 'BRL')))
        .orderBy(desc(fxRates.fetchedOn));

      expect(rows).toHaveLength(2);
      expect(rows[0]?.fetchedOn).toBe(TODAY);
      expect(Number(rows[0]?.rate)).toBe(5.1234);
      expect(rows[1]?.fetchedOn).toBe(YESTERDAY);
      expect(Number(rows[1]?.rate)).toBe(4.9);
    });
  });

  it('resolves (does not throw) on fetcher failure and leaves any existing row unchanged', async () => {
    await withRollback(async (db) => {
      const warnSpy = vi.spyOn(logger, 'warn').mockReturnValue(undefined);
      await seedUsdIncomeSource(db);
      await db.insert(fxRates).values({
        baseCurrency: 'USD',
        quoteCurrency: 'BRL',
        rate: '4.9000',
        fetchedOn: YESTERDAY,
        fetchedAt: new Date('2026-06-02T12:00:00'),
        source: 'seed',
      });

      const fetcher: FxFetcher = vi.fn(async () => {
        throw new Error('network down');
      });
      const service = new FxRateService(db, fetcher);

      await expect(service.refreshIfStale(NOW)).resolves.toBeUndefined();

      expect(fetcher).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledOnce();

      const row = await readUsdBrl(db);
      expect(row?.fetchedOn).toBe(YESTERDAY);
      expect(Number(row?.rate)).toBe(4.9);
      expect(row?.source).toBe('seed');

      warnSpy.mockRestore();
    });
  });
});
