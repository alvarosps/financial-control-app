import type { DbExecutor } from '@fc/db';
import {
  accounts,
  incomeSourceConfigs,
  monthClosings,
  scheduledTransactions,
  transactions,
  userProfiles,
} from '@fc/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger.ts';
import { withRollback } from '../test/with-rollback.ts';
import { DueIncomeAutoCreditService } from './due-income-auto-credit.service.ts';
import { MaterializationGuard } from './materialization-guard.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

async function seedUser(db: DbExecutor): Promise<string> {
  const [u] = await db
    .insert(userProfiles)
    .values({
      email: `auto-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'T',
      passwordHash: 'h',
    })
    .returning();
  return u.id;
}

describe('DueIncomeAutoCreditService', () => {
  it.each([
    'closed month',
    'wallet anchor',
    'foreign wallet',
  ] as const)('leaves income requiring review unpaid without blocking eligible income: %s', async (reason) => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [source] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Income',
          type: 'revenue',
          currency: 'BRL',
        })
        .returning();
      await db.insert(incomeSourceConfigs).values({
        accountId: source.id,
        frequency: 'monthly',
        category: 'salary_clt',
        autoCreditByDate: true,
      });
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Cash',
          type: 'checking',
          currency: 'BRL',
          openingBalanceAnchorAt:
            reason === 'wallet anchor' ? new Date('2026-06-01T03:00:00Z') : null,
        })
        .returning();
      const [other] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Dollar account',
          type: 'checking',
          currency: 'USD',
        })
        .returning();
      const [blocked, eligible] = await db
        .insert(transactions)
        .values([
          {
            userId,
            sourceAccountId: source.id,
            destinationAccountId: reason === 'foreign wallet' ? other.id : wallet.id,
            amount: '100.00',
            currency: 'BRL',
            type: 'deposit',
            description: 'Requires review',
            date: new Date('2026-05-03'),
            domainType: 'income_clt',
            isPaid: false,
          },
          {
            userId,
            sourceAccountId: source.id,
            destinationAccountId: wallet.id,
            amount: '200.00',
            currency: 'BRL',
            type: 'deposit',
            description: 'Eligible income',
            date: new Date('2026-06-03'),
            domainType: 'income_clt',
            isPaid: false,
          },
        ])
        .returning();
      if (reason === 'closed month')
        await db.insert(monthClosings).values({ userId, month: 5, year: 2026, status: 'closed' });
      const service = new DueIncomeAutoCreditService(db, new MaterializationGuard(db));
      const result = await service.run(userId, new Date('2026-06-04'));
      expect(result.credited.map((item) => item.transactionId)).toEqual([eligible.id]);
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, blocked.id)))[0].isPaid,
      ).toBe(false);
      expect((await service.run(userId, new Date('2026-06-04'))).credited).toEqual([]);
    });
  });
  it.each([
    '2026-06-03T09:00:00-03:00',
    '2026-06-03T22:00:00-03:00',
  ])('credits today without inventing future cash or including tomorrow at %s', async (now) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev, wallet] = await db
        .insert(accounts)
        .values([
          { userId, name: 'Salary', type: 'revenue' as const },
          { userId, name: 'Wallet', type: 'checking' as const },
        ])
        .returning();
      await db.insert(incomeSourceConfigs).values({
        accountId: rev.id,
        frequency: 'monthly',
        category: 'salary_clt',
        autoCreditByDate: true,
      });
      const [today] = await db
        .insert(transactions)
        .values(
          ['2026-06-03', '2026-06-04'].map((date) => ({
            userId,
            sourceAccountId: rev.id,
            destinationAccountId: wallet.id,
            amount: '8000.00',
            type: 'deposit' as const,
            domainType: 'income_clt' as const,
            description: date,
            date: new Date(date),
          })),
        )
        .returning();
      const result = await new DueIncomeAutoCreditService(db, new MaterializationGuard(db)).run(
        userId,
      );
      expect(result.credited.map((row) => row.transactionId)).toEqual([today.id]);
      const [row] = await db.select().from(transactions).where(eq(transactions.id, today.id));
      expect(row.settlementDate).toEqual(new Date('2026-06-03T00:00:00-03:00'));
      expect((await new WalletCashService(db).getWalletCash(userId)).totalCash).toBe(0);
    });
  });
  it('defaults to explicit receipt and keeps opted-in date assumptions outside available cash', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev, wallet] = await db
        .insert(accounts)
        .values([
          { userId, name: 'Salary', type: 'revenue' as const },
          { userId, name: 'Wallet', type: 'checking' as const },
        ])
        .returning();
      const [cfg] = await db
        .insert(incomeSourceConfigs)
        .values({ accountId: rev.id, frequency: 'monthly', category: 'salary_clt' })
        .returning();
      const [income] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '8000.00',
          type: 'deposit',
          domainType: 'income_clt',
          description: 'Salary',
          date: new Date('2026-06-03'),
        })
        .returning();
      const service = new DueIncomeAutoCreditService(db, new MaterializationGuard(db));
      expect((await service.run(userId, new Date('2026-06-04T15:00:00Z'))).credited).toHaveLength(
        0,
      );
      await db
        .update(incomeSourceConfigs)
        .set({ autoCreditByDate: true })
        .where(eq(incomeSourceConfigs.id, cfg.id));
      expect((await service.run(userId, new Date('2026-06-04T15:00:00Z'))).credited).toHaveLength(
        1,
      );
      const [row] = await db.select().from(transactions).where(eq(transactions.id, income.id));
      expect(row).toMatchObject({
        isPaid: true,
        settlementSource: 'date_assumed',
        cashAmount: '8000.00',
      });
      expect((await new WalletCashService(db).getWalletCash(userId)).totalCash).toBe(0);
    });
  });
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('credits due, unpaid income into the default wallet and is idempotent', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      await db.insert(incomeSourceConfigs).values({
        accountId: rev.id,
        frequency: 'monthly',
        category: 'salary_clt',
        autoCreditByDate: true,
      });
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          isDefaultWallet: true,
        })
        .returning();
      const [income] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '8000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário',
          date: new Date('2026-06-03'),
          domainType: 'income_clt',
          isPaid: false,
        })
        .returning();

      const service = new DueIncomeAutoCreditService(db, new MaterializationGuard(db));
      const first = await service.run(userId, new Date('2026-06-04'));
      expect(first.credited).toHaveLength(1);
      expect(first.credited[0].amount).toBeCloseTo(8000, 2);
      expect(first.credited[0].walletName).toBe('Itaú');

      const [afterTx] = await db.select().from(transactions).where(eq(transactions.id, income.id));
      expect(afterTx.isPaid).toBe(true);
      expect(afterTx.paidFromAccountId).toBe(wallet.id);

      const second = await service.run(userId, new Date('2026-06-04'));
      expect(second.credited).toHaveLength(0);
    });
  });

  it('does not credit income whose entry date is in the future', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      await db.insert(incomeSourceConfigs).values({
        accountId: rev.id,
        frequency: 'monthly',
        category: 'salary_clt',
        autoCreditByDate: true,
      });
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Itaú', type: 'checking', currency: 'BRL', isDefaultWallet: true })
        .returning();
      await db.insert(transactions).values({
        userId,
        sourceAccountId: rev.id,
        destinationAccountId: wallet.id,
        amount: '8000.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Salário futuro',
        date: new Date('2026-06-20'),
        domainType: 'income_clt',
        isPaid: false,
      });
      const out = await new DueIncomeAutoCreditService(db, new MaterializationGuard(db)).run(
        userId,
        new Date('2026-06-04'),
      );
      expect(out.credited).toHaveLength(0);
    });
  });

  it('skips when there is no usable target wallet', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      await db.insert(incomeSourceConfigs).values({
        accountId: rev.id,
        frequency: 'monthly',
        category: 'salary_clt',
        autoCreditByDate: true,
      });
      // Inactive checking wallet as destination, and NO default wallet exists.
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Itaú', type: 'checking', currency: 'BRL', isActive: false })
        .returning();
      const [income] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '8000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário',
          date: new Date('2026-06-03'),
          domainType: 'income_clt',
          isPaid: false,
        })
        .returning();
      const out = await new DueIncomeAutoCreditService(db, new MaterializationGuard(db)).run(
        userId,
        new Date('2026-06-04'),
      );
      expect(out.credited).toHaveLength(0);
      const [afterTx] = await db.select().from(transactions).where(eq(transactions.id, income.id));
      expect(afterTx.isPaid).toBe(false);
    });
  });

  it('credits the income own destination wallet when it is active checking and not the default', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      await db.insert(incomeSourceConfigs).values({
        accountId: rev.id,
        frequency: 'monthly',
        category: 'salary_clt',
        autoCreditByDate: true,
      });
      const [defaultWallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Default',
          type: 'checking',
          currency: 'BRL',
          isDefaultWallet: true,
        })
        .returning();
      const [w] = await db
        .insert(accounts)
        .values({ userId, name: 'Nubank', type: 'checking', currency: 'BRL' })
        .returning();
      const [income] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: w.id,
          amount: '8000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário',
          date: new Date('2026-06-03'),
          domainType: 'income_clt',
          isPaid: false,
        })
        .returning();

      const out = await new DueIncomeAutoCreditService(db, new MaterializationGuard(db)).run(
        userId,
        new Date('2026-06-04'),
      );
      expect(out.credited).toHaveLength(1);
      expect(out.credited[0].walletName).toBe('Nubank');

      const [afterTx] = await db.select().from(transactions).where(eq(transactions.id, income.id));
      expect(afterTx.paidFromAccountId).toBe(w.id);
      expect(afterTx.paidFromAccountId).not.toBe(defaultWallet.id);
    });
  });

  it('credits forex income converted to BRL using the configured rate', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'USD' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          isDefaultWallet: true,
        })
        .returning();
      const [cfg] = await db
        .insert(incomeSourceConfigs)
        .values({
          accountId: rev.id,
          autoCreditByDate: true,
          frequency: 'monthly',
          category: 'salary_pj',
          exchangeRate: '5.20',
        })
        .returning();
      const [sched] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          description: 'Receita PJ',
          frequency: 'monthly',
          startDate: new Date('2026-06-01'),
          domainType: 'income_pj',
          domainConfigId: cfg.id,
        })
        .returning();
      const [_income] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'Receita PJ',
          date: new Date('2026-06-03'),
          domainType: 'income_pj',
          isPaid: false,
          scheduledTransactionId: sched.id,
        })
        .returning();

      const out = await new DueIncomeAutoCreditService(db, new MaterializationGuard(db)).run(
        userId,
        new Date('2026-06-04'),
      );
      expect(out.credited).toHaveLength(1);
      expect(out.credited[0].amount).toBeCloseTo(5200, 2);

      const [afterTx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, out.credited[0].transactionId));
      expect(afterTx.currency).toBe('USD');
      expect(afterTx.settlementSource).toBe('date_assumed');
      expect(Number(afterTx.cashAmount)).toBeCloseTo(5200, 2);
    });
  });

  it('stores forex income net of the configured conversion fee', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'USD' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          isDefaultWallet: true,
        })
        .returning();
      const [cfg] = await db
        .insert(incomeSourceConfigs)
        .values({
          accountId: rev.id,
          autoCreditByDate: true,
          frequency: 'monthly',
          category: 'salary_pj',
          exchangeRate: '5.00',
          conversionFeePercent: '1',
        })
        .returning();
      const [sched] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          description: 'Receita PJ',
          frequency: 'monthly',
          startDate: new Date('2026-06-01'),
          domainType: 'income_pj',
          domainConfigId: cfg.id,
        })
        .returning();
      const [_income] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'Receita PJ',
          date: new Date('2026-06-03'),
          domainType: 'income_pj',
          isPaid: false,
          scheduledTransactionId: sched.id,
        })
        .returning();

      const out = await new DueIncomeAutoCreditService(db, new MaterializationGuard(db)).run(
        userId,
        new Date('2026-06-04'),
      );
      expect(out.credited).toHaveLength(1);
      // 1000 USD × 5.00 × (1 − 1%) = 4950 (net), NOT 5000 (gross).
      expect(out.credited[0].amount).toBeCloseTo(4950, 2);

      const [afterTx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, out.credited[0].transactionId));
      expect(afterTx.currency).toBe('USD');
      expect(afterTx.settlementSource).toBe('date_assumed');
      expect(Number(afterTx.cashAmount)).toBeCloseTo(4950, 2);
    });
  });

  it('stores the gross BRL value when the conversion fee is zero', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'USD' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          isDefaultWallet: true,
        })
        .returning();
      const [cfg] = await db
        .insert(incomeSourceConfigs)
        .values({
          accountId: rev.id,
          autoCreditByDate: true,
          frequency: 'monthly',
          category: 'salary_pj',
          exchangeRate: '5.00',
          conversionFeePercent: '0',
        })
        .returning();
      const [sched] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          description: 'Receita PJ',
          frequency: 'monthly',
          startDate: new Date('2026-06-01'),
          domainType: 'income_pj',
          domainConfigId: cfg.id,
        })
        .returning();
      const [_income] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'Receita PJ',
          date: new Date('2026-06-03'),
          domainType: 'income_pj',
          isPaid: false,
          scheduledTransactionId: sched.id,
        })
        .returning();

      const out = await new DueIncomeAutoCreditService(db, new MaterializationGuard(db)).run(
        userId,
        new Date('2026-06-04'),
      );
      expect(out.credited).toHaveLength(1);
      // 1000 USD × 5.00 × (1 − 0%) = 5000 (gross — fee=0 leaves behavior unchanged).
      expect(out.credited[0].amount).toBeCloseTo(5000, 2);

      const [afterTx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, out.credited[0].transactionId));
      expect(afterTx.currency).toBe('USD');
      expect(afterTx.settlementSource).toBe('date_assumed');
      expect(Number(afterTx.cashAmount)).toBeCloseTo(5000, 2);
    });
  });

  it('skips forex income with no valid rate', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'USD' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          isDefaultWallet: true,
        })
        .returning();
      const [income] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'Receita PJ',
          date: new Date('2026-06-03'),
          domainType: 'income_pj',
          isPaid: false,
          scheduledTransactionId: null,
        })
        .returning();

      const out = await new DueIncomeAutoCreditService(db, new MaterializationGuard(db)).run(
        userId,
        new Date('2026-06-04'),
      );
      expect(out.credited).toHaveLength(0);
      const [afterTx] = await db.select().from(transactions).where(eq(transactions.id, income.id));
      expect(afterTx.isPaid).toBe(false);
    });
  });
});
