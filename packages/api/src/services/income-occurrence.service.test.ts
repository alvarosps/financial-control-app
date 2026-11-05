import type { DbExecutor } from '@fc/db';
import { accounts, incomeSourceConfigs, transactions, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { IncomeOccurrenceService } from './income-occurrence.service.ts';

async function seedUser(db: DbExecutor): Promise<string> {
  const [u] = await db
    .insert(userProfiles)
    .values({
      email: `occ-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Test User',
      passwordHash: 'hashed',
    })
    .returning();
  return u.id;
}

describe('IncomeOccurrenceService.getOccurrences', () => {
  it('groups materialized income rows by source for the month', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'Inscyth', type: 'revenue', currency: 'USD' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Conta', type: 'checking', currency: 'BRL' })
        .returning();
      await db.insert(incomeSourceConfigs).values({
        accountId: rev.id,
        frequency: 'biweekly',
        category: 'salary_pj',
        exchangeRate: '5.18',
      });
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: false,
        },
        {
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-06-19'),
          domainType: 'income_pj',
          isPaid: true,
        },
        // out of month — must be excluded
        {
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-07-03'),
          domainType: 'income_pj',
          isPaid: false,
        },
      ]);

      const service = new IncomeOccurrenceService(db);
      const result = await service.getOccurrences(userId, 6, 2026);
      const source = result.find((s) => s.accountId === rev.id);
      expect(source).toBeDefined();
      expect(source?.occurrences.map((o) => o.date)).toEqual(['2026-06-05', '2026-06-19']);
      expect(source?.occurrences[0].isPaid).toBe(false);
      expect(source?.occurrences[1].isPaid).toBe(true);
      expect(source?.currency).toBe('USD');
      expect(Number(source?.configRate)).toBe(5.18);
    });
  });

  it('computes net BRL per occurrence (fee-aware) on the server', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [usd] = await db
        .insert(accounts)
        .values({ userId, name: 'Inscyth', type: 'revenue', currency: 'USD' })
        .returning();
      const [brl] = await db
        .insert(accounts)
        .values({ userId, name: 'Salario', type: 'revenue', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Conta', type: 'checking', currency: 'BRL' })
        .returning();
      await db.insert(incomeSourceConfigs).values({
        accountId: usd.id,
        frequency: 'monthly',
        category: 'salary_pj',
        exchangeRate: '5.00',
        conversionFeePercent: '1',
      });
      await db.insert(incomeSourceConfigs).values({
        accountId: brl.id,
        frequency: 'monthly',
        category: 'salary_clt',
      });
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: usd.id,
          destinationAccountId: wallet.id,
          amount: '100.00',
          currency: 'USD',
          type: 'deposit',
          description: 'usd income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: false,
        },
        {
          userId,
          sourceAccountId: brl.id,
          destinationAccountId: wallet.id,
          amount: '3000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'brl income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: false,
        },
      ]);

      const service = new IncomeOccurrenceService(db);
      const result = await service.getOccurrences(userId, 6, 2026);

      const usdSource = result.find((s) => s.accountId === usd.id);
      expect(usdSource?.occurrences[0].amountBrl).toBe('495.00'); // 100 × 5 × 0.99

      const brlSource = result.find((s) => s.accountId === brl.id);
      expect(brlSource?.occurrences[0].amountBrl).toBe(brlSource?.occurrences[0].amount);
      expect(brlSource?.occurrences[0].amountBrl).toBe('3000.00');
    });
  });

  it('still returns occurrences whose revenue source was deactivated', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Old Job',
          type: 'revenue',
          currency: 'BRL',
          isActive: false,
        })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Conta', type: 'checking', currency: 'BRL' })
        .returning();
      await db.insert(transactions).values({
        userId,
        sourceAccountId: rev.id,
        destinationAccountId: wallet.id,
        amount: '3000.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'income',
        date: new Date('2026-06-10'),
        domainType: 'income_pj',
        isPaid: false,
      });

      const service = new IncomeOccurrenceService(db);
      const result = await service.getOccurrences(userId, 6, 2026);
      const source = result.find((s) => s.accountId === rev.id);
      expect(source).toBeDefined();
      expect(source?.occurrences.map((o) => o.date)).toEqual(['2026-06-10']);
    });
  });
});

describe('income mark received (delegates to SettlementService)', () => {
  it('stores BRL on a USD occurrence and redirects the wallet', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'USD' })
        .returning();
      const [walletA] = await db
        .insert(accounts)
        .values({ userId, name: 'A', type: 'checking', currency: 'BRL' })
        .returning();
      const [walletB] = await db
        .insert(accounts)
        .values({ userId, name: 'B', type: 'checking', currency: 'BRL' })
        .returning();
      const [tx] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: walletA.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: false,
        })
        .returning();

      const { SettlementService } = await import('./settlement.service.ts');
      const updated = await new SettlementService(db).settle(userId, {
        transactionId: tx.id,
        walletAccountId: walletB.id,
        leg: 'destination',
        amountOverrideBrl: '5180.00',
      });
      expect(updated.currency).toBe('USD');
      expect(updated.destinationAccountId).toBe(walletB.id);
      expect(Number(updated.cashAmount)).toBeCloseTo(5180, 2);
    });
  });
});
