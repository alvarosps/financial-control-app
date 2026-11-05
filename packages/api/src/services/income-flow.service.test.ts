import type { DbExecutor } from '@fc/db';
import {
  accounts,
  incomeSourceConfigs,
  scheduledTransactions,
  transactions,
  userProfiles,
} from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { IncomeFlowService } from './income-flow.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const flowService = new IncomeFlowService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({
      email: 'income-flow@test.com',
      name: 'Test',
      passwordHash: 'hash',
    })
    .returning();

  const checking = await accountService.create(user.id, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });

  return { accountService, flowService, userId: user.id, checkingId: checking.id };
}

describe('IncomeFlowService', () => {
  it('creates income source with revenue account + config + scheduled deposit', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const { account, config, schedule, materialized } = await flowService.createIncomeSource(
        userId,
        {
          description: 'Salary CLT',
          amount: '8000.00',
          frequency: 'monthly',
          category: 'salary_clt',
          destinationAccountId: checkingId,
          startDate: new Date(2026, 2, 5),
          paymentDay: 5,
        },
      );

      expect(account.type).toBe('revenue');
      expect(account.name).toBe('Salary CLT');
      expect(config.frequency).toBe('monthly');
      expect(config.category).toBe('salary_clt');
      expect(schedule.domainType).toBe('income_clt');
      expect(materialized.created).toBeGreaterThan(0);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
      expect(txs[0].type).toBe('deposit');
    });
  });

  it('creates one-time income', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const { schedule } = await flowService.createIncomeSource(userId, {
        description: 'Freelance Project',
        amount: '5000.00',
        frequency: 'once',
        category: 'freelance',
        destinationAccountId: checkingId,
        startDate: new Date(2026, 3, 15),
      });

      expect(schedule.frequency).toBe('once');
    });
  });

  it('updates an income source (name, category, paymentDay, amount)', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const { account } = await flowService.createIncomeSource(userId, {
        description: 'Salary CLT',
        amount: '8000.00',
        frequency: 'monthly',
        category: 'salary_clt',
        destinationAccountId: checkingId,
        startDate: new Date(2026, 2, 5),
        paymentDay: 5,
      });

      await flowService.update(userId, {
        accountId: account.id,
        description: 'Salary PJ',
        category: 'salary_pj',
        paymentDay: 10,
        amount: '9500.00',
      });

      const updated = await flowService.getById(userId, account.id);
      expect(updated?.account.name).toBe('Salary PJ');
      expect(updated?.config?.category).toBe('salary_pj');
      expect(updated?.config?.paymentDay).toBe(10);

      const [schedule] = await db
        .select()
        .from(scheduledTransactions)
        .where(
          and(
            eq(scheduledTransactions.sourceAccountId, account.id),
            eq(scheduledTransactions.userId, userId),
            eq(scheduledTransactions.isActive, true),
          ),
        );
      expect(schedule.amount).toBe('9500.00');
    });
  });

  it('persists the explicit biweekly anchor on the config', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const { config } = await flowService.createIncomeSource(userId, {
        description: 'Inscyth',
        amount: '5000.00',
        frequency: 'biweekly',
        category: 'salary_pj',
        destinationAccountId: checkingId,
        startDate: new Date('2026-06-05T12:00:00Z'),
        biweeklyAnchor: '2026-05-22',
      });

      const [row] = await db
        .select({ biweeklyAnchor: incomeSourceConfigs.biweeklyAnchor })
        .from(incomeSourceConfigs)
        .where(eq(incomeSourceConfigs.id, config.id));
      expect(row.biweeklyAnchor).toBe('2026-05-22');
    });
  });

  it('defaults the biweekly anchor to the startDate when none is provided', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const { config } = await flowService.createIncomeSource(userId, {
        description: 'Inscyth',
        amount: '5000.00',
        frequency: 'biweekly',
        category: 'salary_pj',
        destinationAccountId: checkingId,
        startDate: new Date('2026-05-22T12:00:00Z'),
      });

      const [row] = await db
        .select({ biweeklyAnchor: incomeSourceConfigs.biweeklyAnchor })
        .from(incomeSourceConfigs)
        .where(eq(incomeSourceConfigs.id, config.id));
      expect(row.biweeklyAnchor).toBe('2026-05-22');
    });
  });

  it('leaves the biweekly anchor unset for non-biweekly income', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);
      const { config } = await flowService.createIncomeSource(userId, {
        description: 'Salary CLT',
        amount: '8000.00',
        frequency: 'monthly',
        category: 'salary_clt',
        destinationAccountId: checkingId,
        startDate: new Date('2026-05-22T12:00:00Z'),
        paymentDay: 5,
      });

      const [row] = await db
        .select({ biweeklyAnchor: incomeSourceConfigs.biweeklyAnchor })
        .from(incomeSourceConfigs)
        .where(eq(incomeSourceConfigs.id, config.id));
      expect(row.biweeklyAnchor).toBeNull();
    });
  });

  it('returns the source even when domain_config_id points at the wrong row', async () => {
    await withRollback(async (db) => {
      const { flowService, userId, checkingId } = await seed(db);

      const { account, schedule } = await flowService.createIncomeSource(userId, {
        description: 'Rocket Lawyer',
        amount: '1000.00',
        frequency: 'monthly',
        category: 'salary_pj',
        destinationAccountId: checkingId,
        startDate: new Date(2026, 0, 15),
        paymentDay: 15,
      });

      // Simulate the migrated bug: point domain_config_id at the revenue account id.
      await db
        .update(scheduledTransactions)
        .set({ domainConfigId: account.id })
        .where(eq(scheduledTransactions.id, schedule.id));

      const list = await flowService.list(userId);
      const entry = list.find((e) => e.account.id === account.id);
      expect(entry?.schedule).not.toBeNull();
      expect(entry?.config).not.toBeNull();
    });
  });
});

describe('IncomeFlowService.editReceivedAmount', () => {
  it('edits a paid income row to the realized BRL amount', async () => {
    await withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'income-edit@test.com', name: 'Test', passwordHash: 'hash' })
        .returning();
      const accountService = new AccountService(db);
      const revenue = await accountService.create(user.id, {
        name: 'rev',
        type: 'revenue',
        currency: 'BRL',
      });
      const wallet = await accountService.create(user.id, {
        name: 'Conta',
        type: 'checking',
        currency: 'BRL',
      });
      const [tx] = await db
        .insert(transactions)
        .values({
          userId: user.id,
          sourceAccountId: revenue.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: true,
          paidAt: new Date('2026-06-05T12:00:00Z'),
        })
        .returning();

      // AccountService creates wallets anchored at now; this case exercises
      // the null-anchor (EPOCH) behavior used by legacy wallets.
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: null })
        .where(eq(accounts.id, wallet.id));

      const service = new IncomeFlowService(db);
      const result = await service.editReceivedAmount(user.id, {
        transactionId: tx.id,
        amountBrl: '1100.00',
      });
      expect(result.success).toBe(true);
      // Sem anchor no wallet -> default EPOCH -> paid_at conta -> afeta saldo.
      expect(result.affectsCurrentBalance).toBe(true);

      const [row] = await db
        .select({
          amount: transactions.amount,
          currency: transactions.currency,
          cashAmount: transactions.cashAmount,
        })
        .from(transactions)
        .where(eq(transactions.id, tx.id));
      expect(row.amount).toBe('1000.00');
      expect(row.cashAmount).toBe('1100.00');
      expect(row.currency).toBe('BRL');
    });
  });

  it('rejects an unpaid income row', async () => {
    await withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'income-edit-unpaid@test.com', name: 'Test', passwordHash: 'hash' })
        .returning();
      const accountService = new AccountService(db);
      const revenue = await accountService.create(user.id, {
        name: 'rev',
        type: 'revenue',
        currency: 'BRL',
      });
      const wallet = await accountService.create(user.id, {
        name: 'Conta',
        type: 'checking',
        currency: 'BRL',
      });
      const [tx] = await db
        .insert(transactions)
        .values({
          userId: user.id,
          sourceAccountId: revenue.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: false,
        })
        .returning();

      const service = new IncomeFlowService(db);
      await expect(
        service.editReceivedAmount(user.id, { transactionId: tx.id, amountBrl: '900.00' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
});
