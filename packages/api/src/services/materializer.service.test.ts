import type { DbExecutor } from '@fc/db';
import {
  accounts,
  creditCardConfigs,
  incomeSourceConfigs,
  scheduledTransactions,
  transactions,
  userProfiles,
} from '@fc/db';
import { InvariantViolationError } from '@fc/domain';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { MaterializerService } from './materializer.service.ts';
import { ScheduledService } from './scheduled.service.ts';

const TEST_USER = {
  email: 'materializer-test@example.com',
  name: 'Materializer Test User',
  passwordHash: 'hashed',
};

async function setupUserAndAccounts(db: DbExecutor) {
  const accountService = new AccountService(db);
  const scheduledService = new ScheduledService(db);
  const materializerService = new MaterializerService(db);

  const [user] = await db.insert(userProfiles).values(TEST_USER).returning();

  const checking = await accountService.create(user.id, {
    name: 'Checking',
    type: 'checking',
    currency: 'BRL',
  });

  const expense = await accountService.create(user.id, {
    name: 'Expenses',
    type: 'expense',
    currency: 'BRL',
  });

  const revenue = await accountService.create(user.id, {
    name: 'Revenue',
    type: 'revenue',
    currency: 'BRL',
  });

  const creditCard = await accountService.create(user.id, {
    name: 'Credit Card',
    type: 'credit_card',
    currency: 'BRL',
  });

  return {
    scheduledService,
    materializerService,
    userId: user.id,
    checking,
    expense,
    revenue,
    creditCard,
  };
}

describe('MaterializerService', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-20T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it('materializes a monthly recurring bill into 3 transactions (horizonMonths=3)', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, creditCard } =
        await setupUserAndAccounts(db);

      await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: creditCard.id,
        amount: '150.00',
        description: 'Netflix',
        frequency: 'monthly',
        startDate: new Date('2026-01-15'),
        dueDay: 15,
      });

      const result = await materializerService.materialize(userId, 3);

      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(3);
      expect(txs[0].type).toBe('withdrawal');
    });
  });

  it('materializes only selected schedules without loading unrelated schedule rows', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, creditCard } =
        await setupUserAndAccounts(db);
      const first = await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: creditCard.id,
        amount: '10.00',
        description: 'Selected',
        frequency: 'monthly',
        startDate: new Date('2026-01-10'),
      });
      const second = await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: creditCard.id,
        amount: '20.00',
        description: 'Unselected',
        frequency: 'monthly',
        startDate: new Date('2026-01-10'),
      });

      const result = await materializerService.materializeSchedules(
        userId,
        [first.id, first.id],
        3,
      );
      const rows = await db.select().from(transactions).where(eq(transactions.userId, userId));

      expect(result.scope).toBe('targeted');
      expect(result.schedulesLoaded).toBe(1);
      expect(rows.filter((row) => row.scheduledTransactionId === first.id)).toHaveLength(3);
      expect(rows.filter((row) => row.scheduledTransactionId === second.id)).toHaveLength(0);
    });
  });

  it('returns a targeted no-op for an empty selection', async () => {
    await withRollback(async (db) => {
      const { materializerService, userId } = await setupUserAndAccounts(db);

      await expect(materializerService.materializeSchedules(userId, [])).resolves.toMatchObject({
        scope: 'targeted',
        schedulesLoaded: 0,
        created: 0,
      });
    });
  });

  it('materializes full installment series from occurrence 1 (normalized input)', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, creditCard } =
        await setupUserAndAccounts(db);

      await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: creditCard.id,
        amount: '100.00',
        description: 'Phone purchase',
        frequency: 'monthly',
        startDate: new Date('2026-01-10'),
        totalOccurrences: 10,
        startingOccurrence: 1,
      });

      const result = await materializerService.materialize(userId, 12);

      expect(result.created).toBe(10);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));

      expect(txs).toHaveLength(10);
      expect(txs[0].installmentNumber).toBe(1);
      expect(txs[0].totalInstallments).toBe(10);
      expect(txs[9].installmentNumber).toBe(10);
    });
  });

  it('does NOT duplicate an installment when start_date is shifted between runs', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, creditCard } =
        await setupUserAndAccounts(db);

      const schedule = await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: creditCard.id,
        amount: '100.00',
        description: 'Parcela',
        frequency: 'monthly',
        startDate: new Date('2026-01-10'),
        totalOccurrences: 6,
        startingOccurrence: 1,
      });

      const first = await materializerService.materialize(userId, 12);
      expect(first.created).toBe(6);

      // The user later edits the schedule's start_date (shifts the day-of-month).
      // computeOccurrenceDates now yields different occurrence dates, so the
      // date-keyed dedup misses them — only the occurrence-identity dedup prevents
      // a second row per installment_number.
      await db
        .update(scheduledTransactions)
        .set({ startDate: new Date('2026-01-11') })
        .where(eq(scheduledTransactions.id, schedule.id));

      await materializerService.materialize(userId, 12);

      const linked = await db
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      const nonReversed = linked.filter((t) => !t.isReversed);

      // Exactly the 6 original occurrences — no duplicate per installment_number.
      expect(nonReversed).toHaveLength(6);

      const byInstallment = new Map<number, number>();
      for (const t of nonReversed) {
        if (t.installmentNumber != null) {
          byInstallment.set(t.installmentNumber, (byInstallment.get(t.installmentNumber) ?? 0) + 1);
        }
      }
      const duplicated = [...byInstallment.entries()].filter(([, count]) => count > 1);
      expect(duplicated).toEqual([]);
    });
  });

  it('skips schedules with startingOccurrence != 1 and reports them instead of aborting', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, creditCard } =
        await setupUserAndAccounts(db);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const [bad] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Bad legacy data',
          frequency: 'monthly',
          startDate: new Date('2026-01-10'),
          totalOccurrences: 10,
          startingOccurrence: 3,
        })
        .returning();

      await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: creditCard.id,
        amount: '150.00',
        description: 'Netflix',
        frequency: 'monthly',
        startDate: new Date('2026-01-15'),
        dueDay: 15,
      });

      const result = await materializerService.materialize(userId, 3);

      expect(result.invalidSchedules).toEqual([{ scheduleId: bad.id, startingOccurrence: 3 }]);
      expect(result.created).toBe(3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(bad.id));

      const badRows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, bad.id));
      expect(badRows).toHaveLength(0);
    });
  });

  it('does NOT create duplicates on re-materialization', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, creditCard } =
        await setupUserAndAccounts(db);

      await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: creditCard.id,
        amount: '150.00',
        description: 'Netflix',
        frequency: 'monthly',
        startDate: new Date('2026-01-15'),
        dueDay: 15,
      });

      const first = await materializerService.materialize(userId, 3);
      expect(first.created).toBe(3);

      const second = await materializerService.materialize(userId, 3);
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(3);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(3);
    });
  });

  it('auto-assigns billingMonth/billingYear for credit card destinations', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, creditCard } =
        await setupUserAndAccounts(db);

      await db.insert(creditCardConfigs).values({
        accountId: creditCard.id,
        closingDay: 3,
        dueDay: 10,
      });

      await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: creditCard.id,
        amount: '200.00',
        description: 'Amazon purchase',
        frequency: 'once',
        startDate: new Date('2026-03-15'),
      });

      await materializerService.materialize(userId, 3);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(1);
      expect(txs[0].billingMonth).toBe(4);
      expect(txs[0].billingYear).toBe(2026);
    });
  });

  it('materializes one-time expense (1 transaction)', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, checking } =
        await setupUserAndAccounts(db);

      await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: checking.id,
        amount: '500.00',
        description: 'One-time repair',
        frequency: 'once',
        startDate: new Date('2026-03-20'),
      });

      const result = await materializerService.materialize(userId, 3);

      expect(result.created).toBe(1);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(1);
    });
  });

  it('materializes income deposits (type=deposit)', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, revenue, checking } =
        await setupUserAndAccounts(db);

      await scheduledService.create(userId, {
        sourceAccountId: revenue.id,
        destinationAccountId: checking.id,
        amount: '5000.00',
        description: 'Monthly salary',
        frequency: 'monthly',
        startDate: new Date('2026-01-05'),
        dueDay: 5,
        domainType: 'income_clt',
      });

      const result = await materializerService.materialize(userId, 3);

      expect(result.created).toBe(3);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(3);
      expect(txs[0].type).toBe('deposit');
      expect(txs[0].domainType).toBe('income_clt');
    });
  });

  it('skips inactive schedules', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, creditCard } =
        await setupUserAndAccounts(db);

      const schedule = await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: creditCard.id,
        amount: '100.00',
        description: 'Inactive bill',
        frequency: 'monthly',
        startDate: new Date('2026-01-01'),
      });

      await scheduledService.deactivate(userId, schedule.id);

      const result = await materializerService.materialize(userId, 3);

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(0);
    });
  });

  it('does NOT duplicate an installment already covered by a manual (unlinked) row', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, checking } =
        await setupUserAndAccounts(db);

      await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: checking.id,
        amount: '100.00',
        description: 'Parcela',
        frequency: 'monthly',
        startDate: new Date('2026-01-10'),
        totalOccurrences: 3,
        startingOccurrence: 1,
      });

      // Manually inserted reconciliation row (no schedule link) covering installment 2:
      // same source/dest/amount and installment number, different date/description.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expense.id,
        destinationAccountId: checking.id,
        amount: '100.00',
        type: 'deposit',
        description: 'Parcela 2 (manual)',
        date: new Date('2026-02-10'),
        installmentNumber: 2,
        totalInstallments: 3,
      });

      const result = await materializerService.materialize(userId, 12);

      // Installment 2 is recognised as covered → only 1 and 3 are materialized.
      expect(result.created).toBe(2);
      expect(result.skipped).toBe(1);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(3);
      const linked = txs.filter((t) => t.scheduledTransactionId !== null);
      expect(linked).toHaveLength(2);
      expect(linked.map((t) => t.installmentNumber).sort()).toEqual([1, 3]);
    });
  });

  it('propagates the schedule currency to materialized transactions (USD, not default BRL)', async () => {
    await withRollback(async (db) => {
      const warnSpy = vi.spyOn(logger, 'warn').mockReturnValue(undefined);
      const { materializerService, userId, revenue, checking } = await setupUserAndAccounts(db);

      // Schedule carries currency='USD' (e.g. the "Inscyth" PJ income). Inserted
      // directly so the currency column is set regardless of ScheduledService input.
      await db.insert(scheduledTransactions).values({
        userId,
        sourceAccountId: revenue.id,
        destinationAccountId: checking.id,
        amount: '2769.60',
        currency: 'USD',
        description: 'Inscyth',
        frequency: 'monthly',
        startDate: new Date('2026-01-05'),
        dueDay: 5,
        totalOccurrences: 3,
        startingOccurrence: 1,
        domainType: 'income_pj',
        isActive: true,
      });

      const result = await materializerService.materialize(userId, 12);
      expect(result.created).toBe(3);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(3);
      for (const tx of txs) {
        expect(tx.currency).toBe('USD');
      }
      expect(warnSpy).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'USD' }),
        expect.stringContaining('accounts.current_balance will mix currencies'),
      );

      warnSpy.mockRestore();
    });
  });

  it('still materializes when a manual row differs in content (no false suppression)', async () => {
    await withRollback(async (db) => {
      const { scheduledService, materializerService, userId, expense, checking } =
        await setupUserAndAccounts(db);

      await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: checking.id,
        amount: '100.00',
        description: 'Parcela',
        frequency: 'monthly',
        startDate: new Date('2026-01-10'),
        totalOccurrences: 3,
        startingOccurrence: 1,
      });

      // A manual row with a DIFFERENT amount must NOT suppress any occurrence.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expense.id,
        destinationAccountId: checking.id,
        amount: '999.00',
        type: 'deposit',
        description: 'Unrelated manual charge',
        date: new Date('2026-02-10'),
        installmentNumber: 2,
        totalInstallments: 3,
      });

      const result = await materializerService.materialize(userId, 12);

      // All 3 installments still materialize alongside the unrelated manual row.
      expect(result.created).toBe(3);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs).toHaveLength(4);
      expect(txs.filter((t) => t.scheduledTransactionId !== null)).toHaveLength(3);
    });
  });
});

describe('MaterializerService horizon cap', () => {
  it('rejects horizon > 36', async () => {
    await withRollback(async (db) => {
      const [u] = await db
        .insert(userProfiles)
        .values({
          email: 'horizon-max@example.com',
          name: 'Horizon Max',
          passwordHash: 'hashed',
        })
        .returning();
      const svc = new MaterializerService(db);
      await expect(svc.materialize(u.id, 121)).rejects.toBeInstanceOf(InvariantViolationError);
      await expect(svc.materialize(u.id, 1000)).rejects.toBeInstanceOf(InvariantViolationError);
    });
  });

  it('accepts horizon = 120 (boundary)', async () => {
    await withRollback(async (db) => {
      const [u] = await db
        .insert(userProfiles)
        .values({
          email: 'horizon-boundary@example.com',
          name: 'Horizon Boundary',
          passwordHash: 'hashed',
        })
        .returning();
      const svc = new MaterializerService(db);
      await expect(svc.materialize(u.id, 120)).resolves.toBeDefined();
    });
  });

  it('rejects horizon < 1', async () => {
    await withRollback(async (db) => {
      const [u] = await db
        .insert(userProfiles)
        .values({
          email: 'horizon-min@example.com',
          name: 'Horizon Min',
          passwordHash: 'hashed',
        })
        .returning();
      const svc = new MaterializerService(db);
      await expect(svc.materialize(u.id, 0)).rejects.toBeInstanceOf(InvariantViolationError);
      await expect(svc.materialize(u.id, -1)).rejects.toBeInstanceOf(InvariantViolationError);
    });
  });
});

describe('MaterializerService orphan account guard', () => {
  it('throws InvariantViolationError when a schedule references an account absent from the user-scoped accountTypeMap', async () => {
    await withRollback(async (db) => {
      const [userA] = await db
        .insert(userProfiles)
        .values({
          email: 'orphan-a@example.com',
          name: 'Orphan A',
          passwordHash: 'hashed',
        })
        .returning();
      const [userB] = await db
        .insert(userProfiles)
        .values({
          email: 'orphan-b@example.com',
          name: 'Orphan B',
          passwordHash: 'hashed',
        })
        .returning();

      // acctB belongs to user B
      const [acctB] = await db
        .insert(accounts)
        .values({
          userId: userB.id,
          name: 'B-bank',
          type: 'checking',
          isActive: true,
        })
        .returning();
      // acctA belongs to user A
      const [acctA] = await db
        .insert(accounts)
        .values({
          userId: userA.id,
          name: 'A-card',
          type: 'credit_card',
          isActive: true,
        })
        .returning();

      // Schedule owned by A references an account owned by B as source → cross-user orphan
      await db.insert(scheduledTransactions).values({
        userId: userA.id,
        sourceAccountId: acctB.id,
        destinationAccountId: acctA.id,
        amount: '10.00',
        description: 'x',
        frequency: 'monthly',
        startDate: new Date('2026-01-01'),
        startingOccurrence: 1,
        isActive: true,
      });

      const svc = new MaterializerService(db);
      await expect(svc.materialize(userA.id, 12)).rejects.toBeInstanceOf(InvariantViolationError);
    });
  });
});

async function seedUser(db: DbExecutor): Promise<string> {
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `income-rules-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Income Rules Test User',
      passwordHash: 'hashed',
    })
    .returning();
  return user.id;
}

describe('materializer — income date rules', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-20T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('biweekly income steps 14 days from biweekly_anchor (3 occurrences in July)', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db); // existing helper in this file
      const [revenue] = await db
        .insert(accounts)
        .values({ userId, name: 'Inscyth', type: 'revenue', currency: 'USD' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Conta', type: 'checking', currency: 'BRL' })
        .returning();
      const [config] = await db
        .insert(incomeSourceConfigs)
        .values({
          accountId: revenue.id,
          frequency: 'biweekly',
          category: 'salary_pj',
          biweeklyAnchor: '2026-05-22',
        })
        .returning();
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          description: 'Inscyth',
          frequency: 'biweekly',
          startDate: new Date('2023-09-01'),
          startingOccurrence: 1,
          domainType: 'income_pj',
          domainConfigId: config.id,
        })
        .returning();

      const warnSpy = vi.spyOn(logger, 'warn').mockReturnValue(undefined);
      const service = new MaterializerService(db);
      await service.materialize(userId, 4);
      expect(warnSpy).toHaveBeenCalled();

      const rows = await db
        .select({ date: transactions.date })
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      const keys = rows.map((r) => new Date(r.date).toISOString().slice(0, 10)).sort();
      expect(keys).toContain('2026-06-05');
      expect(keys).toContain('2026-06-19');
      expect(keys).toContain('2026-07-03');
      expect(keys).toContain('2026-07-17');
      expect(keys).toContain('2026-07-31');

      warnSpy.mockRestore();
    });
  });

  it('CLT income rolls a weekend pay day back to the previous business day', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [revenue] = await db
        .insert(accounts)
        .values({ userId, name: 'CLT 15', type: 'revenue', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Conta', type: 'checking', currency: 'BRL' })
        .returning();
      const [config] = await db
        .insert(incomeSourceConfigs)
        .values({
          accountId: revenue.id,
          frequency: 'monthly',
          category: 'salary_clt',
          paymentDay: 15,
        })
        .returning();
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: wallet.id,
          amount: '5000.00',
          currency: 'BRL',
          description: 'CLT',
          frequency: 'monthly',
          startDate: new Date('2026-02-01'),
          dueDay: 15,
          startingOccurrence: 1,
          domainType: 'income_clt',
          domainConfigId: config.id,
        })
        .returning();

      const service = new MaterializerService(db);
      await service.materialize(userId, 2);

      const rows = await db
        .select({ date: transactions.date })
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      const keys = rows.map((r) => new Date(r.date).toISOString().slice(0, 10)).sort();
      // 15 Feb/Mar 2026 are Sundays → must land on the Fridays before; horizon=2
      // from a Feb-1 start yields exactly Feb + Mar. The EXACT set guards against
      // the UTC-parse off-by-one that would emit a phantom 2026-01-15 row on a
      // negative-offset host (America/Sao_Paulo). See toLocalCalendarDay.
      expect(keys).toEqual(['2026-02-13', '2026-03-13']);
      expect(keys).not.toContain('2026-02-15');
      expect(keys).not.toContain('2026-01-15');
    });
  });

  it('re-materialize does not duplicate a paid monthly CLT row whose computed date shifts', async () => {
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [revenue] = await db
        .insert(accounts)
        .values({ userId, name: 'CLT', type: 'revenue', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Conta', type: 'checking', currency: 'BRL' })
        .returning();
      const [config] = await db
        .insert(incomeSourceConfigs)
        .values({
          accountId: revenue.id,
          frequency: 'monthly',
          category: 'salary_clt',
          paymentDay: 15,
        })
        .returning();
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: wallet.id,
          amount: '5000.00',
          currency: 'BRL',
          description: 'CLT',
          frequency: 'monthly',
          startDate: new Date('2026-08-01'),
          dueDay: 15,
          startingOccurrence: 1,
          domainType: 'income_clt',
          domainConfigId: config.id,
        })
        .returning();
      // A PAID row already exists on the NOMINAL Saturday 2026-08-15 (a pre-roll/shifted paid row).
      await db.insert(transactions).values({
        userId,
        sourceAccountId: revenue.id,
        destinationAccountId: wallet.id,
        amount: '5000.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'CLT',
        date: new Date('2026-08-15'),
        domainType: 'income_clt',
        isPaid: true,
        scheduledTransactionId: schedule.id,
      });

      // Now materialize: the engine computes Aug 15 (Sat) → rolls to Aug 14 (Fri) ≠ the paid row's date.
      // Without the month-bucket dedup this inserts a second (unpaid) Aug row.
      const service = new MaterializerService(db);
      await service.materialize(userId, 1);

      const augRows = await db
        .select({ date: transactions.date })
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.domainType, 'income_clt'),
          ),
        );
      const augKeys = augRows
        .map((r) => new Date(r.date).toISOString().slice(0, 10))
        .filter((k) => k.startsWith('2026-08'));
      // Exactly one Aug occurrence — the preserved paid row; no rolled duplicate.
      expect(augKeys).toEqual(['2026-08-15']);
    });
  });

  it('re-materialize does not duplicate a monthly card fixed charge whose date shifts across a month boundary', async () => {
    vi.setSystemTime(new Date('2026-04-01T12:00:00Z'));
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [expense] = await db
        .insert(accounts)
        .values({ userId, name: 'Expenses', type: 'expense', currency: 'BRL' })
        .returning();
      const [card] = await db
        .insert(accounts)
        .values({ userId, name: 'Card', type: 'credit_card', currency: 'BRL' })
        .returning();
      await db.insert(creditCardConfigs).values({ accountId: card.id, closingDay: 25, dueDay: 5 });
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          amount: '37.00',
          currency: 'BRL',
          description: 'Anuidade',
          frequency: 'monthly',
          startDate: new Date('2026-01-01'),
          dueDay: 1,
          startingOccurrence: 1,
          domainType: 'credit_card_fixed_charge',
        })
        .returning();

      const service = new MaterializerService(db);
      // First run materializes one fixed-charge row per billing month (dated first-of-month).
      await service.materialize(userId, 3);
      const firstRows = await db
        .select({ id: transactions.id, date: transactions.date })
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      expect(firstRows.length).toBeGreaterThan(0);

      // Simulate the local-calendar-day date normalization (commit c959f92): each stored
      // date moves back one day — crossing the month boundary for first-of-month rows
      // (2026-04-01 -> 2026-03-31) — while billingMonth/billingYear stay put. Mark paid.
      for (const r of firstRows) {
        const shifted = new Date(r.date);
        shifted.setDate(shifted.getDate() - 1);
        await db
          .update(transactions)
          .set({ date: shifted, isPaid: true })
          .where(eq(transactions.id, r.id));
      }

      // Second run: the engine recomputes the original first-of-month dates, so BOTH the
      // date-only key AND a date-month key miss (existing rows now sit in the prior month).
      // Only the billing-month bucket recognises each (schedule, billing month) → 0 created.
      const second = await service.materialize(userId, 3);
      expect(second.created).toBe(0);

      const afterRows = await db
        .select({ bm: transactions.billingMonth, by: transactions.billingYear })
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      expect(afterRows.length).toBe(firstRows.length);
      const perBilling = new Map<string, number>();
      for (const r of afterRows) {
        const k = `${r.by}-${r.bm}`;
        perBilling.set(k, (perBilling.get(k) ?? 0) + 1);
      }
      const dups = [...perBilling.entries()].filter(([, c]) => c > 1);
      expect(dups).toEqual([]);
    });
  });
});

describe('materializer — firstBilling on non-installment card charges', () => {
  beforeEach(() => {
    // A mid-June "now" lets a 12-month horizon materialize several occurrences
    // for the monthly fixed charge below.
    vi.setSystemTime(new Date('2026-06-20T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("'once' avulsa forces billing via firstBilling and preserves the purchase date", async () => {
    await withRollback(async (db) => {
      const { materializerService, userId, expense, creditCard } = await setupUserAndAccounts(db);

      // closingDay 6: a 3 July purchase (day 3 <= 6) would normally bill to JULY.
      await db.insert(creditCardConfigs).values({
        accountId: creditCard.id,
        closingDay: 6,
        dueDay: 13,
      });

      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '321.00',
          currency: 'BRL',
          description: 'Avulsa forçada',
          frequency: 'once',
          // LOCAL constructor: 3 July 2026 (monthIndex 6). Deliberately a date
          // closing-day logic would bill to July (day 3 <= closing 6 => July).
          startDate: new Date(2026, 6, 3),
          totalOccurrences: 1,
          startingOccurrence: 1,
          firstBillingMonth: 6,
          firstBillingYear: 2026,
          domainType: 'credit_card_expense',
          isActive: true,
        })
        .returning();

      const result = await materializerService.materialize(userId, 3);
      expect(result.created).toBe(1);

      const rows = await db
        .select({
          billingMonth: transactions.billingMonth,
          billingYear: transactions.billingYear,
          date: transactions.date,
        })
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));

      // Exactly one row for this schedule.
      expect(rows).toHaveLength(1);

      // firstBilling forces the fatura to JUNE 2026, NOT the July the closing-day
      // logic would have assigned.
      expect(rows[0].billingMonth).toBe(6);
      expect(rows[0].billingYear).toBe(2026);

      // The purchase date is preserved as 2026-07-03 (forcing the bill does not
      // move the transaction date). date(mode:'date') reads back as UTC-midnight.
      expect(new Date(rows[0].date).toISOString().slice(0, 10)).toBe('2026-07-03');
    });
  });

  it('monthly card fixed charge with firstBilling advances per occurrence and is idempotent', async () => {
    await withRollback(async (db) => {
      const { materializerService, userId, expense, creditCard } = await setupUserAndAccounts(db);

      await db.insert(creditCardConfigs).values({
        accountId: creditCard.id,
        closingDay: 6,
        dueDay: 13,
      });

      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '49.90',
          currency: 'BRL',
          description: 'Assinatura fixa',
          frequency: 'monthly',
          // LOCAL constructor: 1 June 2026 (monthIndex 5).
          startDate: new Date(2026, 5, 1),
          totalOccurrences: null,
          startingOccurrence: 1,
          firstBillingMonth: 6,
          firstBillingYear: 2026,
          domainType: 'credit_card_fixed_charge',
          isActive: true,
        })
        .returning();

      const first = await materializerService.materialize(userId, 12);
      expect(first.created).toBeGreaterThan(1);

      const rows = await db
        .select({
          billingMonth: transactions.billingMonth,
          billingYear: transactions.billingYear,
        })
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));

      // Each occurrence's billing = firstBilling (2026-06) + index, advancing per
      // occurrence: a contiguous run 2026-06, 2026-07, 2026-08, ...
      const ords = rows
        .map((r) => (r.billingYear as number) * 12 + ((r.billingMonth as number) - 1))
        .sort((a, b) => a - b);
      const firstOrd = 2026 * 12 + (6 - 1);
      expect(ords[0]).toBe(firstOrd);
      for (let i = 0; i < ords.length; i++) {
        expect(ords[i]).toBe(firstOrd + i);
      }
      // The FIRST occurrence is explicitly billingMonth 6 / year 2026.
      expect(ords[0]).toBe(2026 * 12 + 5);

      // Re-materialize: the billing-month bucket dedup must hold even though
      // firstBilling forces the billing period — NO new rows.
      const second = await materializerService.materialize(userId, 12);
      expect(second.created).toBe(0);

      const afterRows = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      expect(afterRows.length).toBe(rows.length);
    });
  });
});
