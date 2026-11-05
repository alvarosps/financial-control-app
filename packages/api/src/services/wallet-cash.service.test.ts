import type { DbExecutor } from '@fc/db';
import { accounts, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { WalletCashService } from './wallet-cash.service.ts';

const QUERY_VERBS = new Set(['select', 'insert', 'update', 'delete', 'execute']);

function withQueryCounter(db: DbExecutor): { counted: DbExecutor; queries: () => number } {
  let count = 0;
  const counted = new Proxy(db, {
    get(target, prop) {
      if (typeof prop === 'string' && QUERY_VERBS.has(prop)) count += 1;
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { counted, queries: () => count };
}

async function seedUser(db: DbExecutor): Promise<string> {
  const [u] = await db
    .insert(userProfiles)
    .values({
      email: `wc-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Test User',
      passwordHash: 'hashed',
    })
    .returning();
  return u.id;
}

const ANCHOR = new Date('2026-06-01T00:00:00Z');
const BEFORE = new Date('2026-05-01T00:00:00Z');
const AFTER = new Date('2026-06-10T00:00:00Z');

describe('WalletCashService.getWalletCash', () => {
  it('uses net BRL cash, zero deductions and effective days without treating assumed or unknown FX receipts as available', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [wallet, revenue, loan] = await db
        .insert(accounts)
        .values([
          {
            userId,
            name: 'Wallet',
            type: 'checking' as const,
            openingBalance: '100.00',
            openingBalanceAnchorAt: new Date('2026-06-01T15:00:00Z'),
            cashAnchorBasis: 'effective' as const,
          },
          { userId, name: 'Income', type: 'revenue' as const },
          { userId, name: 'Loan', type: 'loan' as const },
        ])
        .returning();
      const base = {
        userId,
        date: new Date('2026-06-03'),
        isPaid: true,
        paidAt: new Date('2026-06-20T15:00:00Z'),
        settlementDate: new Date('2026-06-10T15:00:00Z'),
        settlementSource: 'manual' as const,
        description: 'cash fixture',
      };
      const rows = await db
        .insert(transactions)
        .values([
          {
            ...base,
            sourceAccountId: revenue.id,
            destinationAccountId: wallet.id,
            type: 'deposit' as const,
            domainType: 'income_clt' as const,
            amount: '10000.00',
            cashAmount: '9000.00',
          },
          {
            ...base,
            sourceAccountId: wallet.id,
            destinationAccountId: loan.id,
            type: 'withdrawal' as const,
            domainType: 'loan_payment' as const,
            amount: '1000.00',
            cashAmount: '0.00',
          },
          {
            ...base,
            sourceAccountId: wallet.id,
            destinationAccountId: loan.id,
            type: 'withdrawal' as const,
            domainType: 'loan_payment' as const,
            amount: '500.00',
            cashAmount: '500.00',
          },
          {
            ...base,
            sourceAccountId: revenue.id,
            destinationAccountId: wallet.id,
            type: 'deposit' as const,
            domainType: 'income_pj' as const,
            amount: '2000.00',
            currency: 'USD',
            cashAmount: '9500.00',
          },
          {
            ...base,
            sourceAccountId: revenue.id,
            destinationAccountId: wallet.id,
            type: 'deposit' as const,
            domainType: 'income_pj' as const,
            amount: '1000.00',
            currency: 'USD',
            cashAmount: null,
            settlementSource: 'legacy' as const,
          },
          {
            ...base,
            sourceAccountId: revenue.id,
            destinationAccountId: wallet.id,
            type: 'deposit' as const,
            domainType: 'income_clt' as const,
            amount: '200.00',
            cashAmount: '200.00',
            settlementSource: 'date_assumed' as const,
          },
          {
            ...base,
            sourceAccountId: revenue.id,
            destinationAccountId: wallet.id,
            type: 'deposit' as const,
            amount: '999.00',
            cashAmount: '999.00',
            settlementDate: new Date('2026-06-01T15:00:00Z'),
          },
        ])
        .returning();
      const service = new WalletCashService(db);
      const asOf = new Date('2026-06-15T18:00:00Z');
      expect((await service.getWalletCash(userId, asOf)).totalCash).toBe(18100);
      const series = await service.getWalletCashSeries(userId, 14, asOf);
      expect(series.find((point) => point.date === '2026-06-09')?.total).toBe(100);
      expect(series.at(-1)?.total).toBe(18100);
      await db
        .update(transactions)
        .set({ isReversed: true })
        .where(eq(transactions.id, rows[0].id));
      expect((await service.getWalletCash(userId, asOf)).totalCash).toBe(9100);
      expect((await service.getWalletCashSeries(userId, 14, asOf)).at(-1)?.total).toBe(9100);
    });
  });

  it('returns opening balance when there are no post-anchor paid movements', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      await db.insert(accounts).values({
        userId,
        name: 'Itaú',
        type: 'checking',
        currency: 'BRL',
        openingBalance: '-14830.46',
        openingBalanceAnchorAt: ANCHOR,
        isDefaultWallet: true,
      });

      const overview = await new WalletCashService(db).getWalletCash(
        userId,
        new Date('2026-06-30'),
      );
      expect(overview.totalCash).toBeCloseTo(-14830.46, 2);
      expect(overview.wallets).toHaveLength(1);
      expect(overview.wallets[0].cash).toBeCloseTo(-14830.46, 2);
    });
  });

  it('adds paid credits and subtracts paid debits settled AFTER the anchor', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      const [exp] = await db
        .insert(accounts)
        .values({ userId, name: 'exp', type: 'expense', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '-1000.00',
          openingBalanceAnchorAt: ANCHOR,
        })
        .returning();

      await db.insert(transactions).values({
        userId,
        sourceAccountId: rev.id,
        destinationAccountId: wallet.id,
        amount: '500.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'salary',
        date: new Date('2026-06-05'),
        domainType: 'income_clt',
        isPaid: true,
        paidAt: AFTER,
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: wallet.id,
        destinationAccountId: exp.id,
        amount: '200.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'bill',
        date: new Date('2026-06-07'),
        domainType: 'recurring_bill',
        isPaid: true,
        paidAt: AFTER,
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: wallet.id,
        destinationAccountId: exp.id,
        amount: '999.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'old bill',
        date: new Date('2026-05-05'),
        domainType: 'recurring_bill',
        isPaid: true,
        paidAt: BEFORE,
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: wallet.id,
        destinationAccountId: exp.id,
        amount: '300.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'future bill',
        date: new Date('2026-06-20'),
        domainType: 'recurring_bill',
        isPaid: false,
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: wallet.id,
        destinationAccountId: exp.id,
        amount: '50.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'reversed',
        date: new Date('2026-06-08'),
        domainType: 'recurring_bill',
        isPaid: true,
        paidAt: AFTER,
        isReversed: true,
      });

      const overview = await new WalletCashService(db).getWalletCash(
        userId,
        new Date('2026-06-30'),
      );
      expect(overview.totalCash).toBeCloseTo(-700, 2);
    });
  });

  it('treats a null anchor as epoch (counts all paid movements)', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'W', type: 'checking', currency: 'BRL' })
        .returning();
      await db.insert(transactions).values({
        userId,
        sourceAccountId: rev.id,
        destinationAccountId: wallet.id,
        amount: '123.45',
        currency: 'BRL',
        type: 'deposit',
        description: 'x',
        date: new Date('2020-01-01'),
        domainType: 'income_clt',
        isPaid: true,
        paidAt: new Date('2020-01-01'),
      });
      const overview = await new WalletCashService(db).getWalletCash(
        userId,
        new Date('2026-06-30'),
      );
      expect(overview.totalCash).toBeCloseTo(123.45, 2);
    });
  });

  it('excludes internal family-loan ledger rows but counts a real family-loan payment', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [familyLoan] = await db
        .insert(accounts)
        .values({ userId, name: 'Célia', type: 'family_loan', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '-1000.00',
          openingBalanceAnchorAt: ANCHOR,
        })
        .returning();

      // Internal ledger adjustment: a PAID discount transfer (wallet -> family_loan)
      // settled AFTER the anchor. It is NOT real cash and must NOT be subtracted.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: wallet.id,
        destinationAccountId: familyLoan.id,
        amount: '1534.50',
        currency: 'BRL',
        type: 'transfer',
        description: 'Carro Camila',
        date: new Date('2026-06-10'),
        domainType: 'family_loan_discount',
        isPaid: true,
        paidAt: AFTER,
      });
      // A REAL payment received (family_loan -> wallet) IS genuine cash in.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: familyLoan.id,
        destinationAccountId: wallet.id,
        amount: '200.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Pagamento recebido',
        date: new Date('2026-06-12'),
        domainType: 'family_loan_payment',
        isPaid: true,
        paidAt: AFTER,
      });

      const overview = await new WalletCashService(db).getWalletCash(
        userId,
        new Date('2026-06-30'),
      );
      // -1000 opening + 200 real payment; the 1534.50 discount is excluded.
      expect(overview.totalCash).toBeCloseTo(-800, 2);
    });
  });

  it('excludes non-checking and non-BRL accounts', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      await db.insert(accounts).values({
        userId,
        name: 'savings',
        type: 'savings',
        currency: 'BRL',
        openingBalance: '5000.00',
        openingBalanceAnchorAt: ANCHOR,
      });
      await db.insert(accounts).values({
        userId,
        name: 'usd',
        type: 'checking',
        currency: 'USD',
        openingBalance: '5000.00',
        openingBalanceAnchorAt: ANCHOR,
      });
      const overview = await new WalletCashService(db).getWalletCash(
        userId,
        new Date('2026-06-30'),
      );
      expect(overview.wallets).toHaveLength(0);
      expect(overview.totalCash).toBeCloseTo(0, 2);
    });
  });
});

describe('WalletCashService.getWalletCashSeries', () => {
  it('returns N+1 cumulative daily points anchored on canonical cash', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [revenue] = await db
        .insert(accounts)
        .values({ userId, name: 'Revenue', type: 'revenue', currency: 'BRL' })
        .returning();
      const [expense] = await db
        .insert(accounts)
        .values({ userId, name: 'Expense', type: 'expense', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '1000.00',
          openingBalanceAnchorAt: ANCHOR,
        })
        .returning();

      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: wallet.id,
          amount: '500.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salary',
          date: new Date('2026-06-28'),
          domainType: 'income_clt',
          isPaid: true,
          paidAt: AFTER,
        },
        {
          userId,
          sourceAccountId: wallet.id,
          destinationAccountId: expense.id,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Bill',
          date: new Date('2026-06-29'),
          domainType: 'recurring_bill',
          isPaid: true,
          paidAt: AFTER,
        },
      ]);

      const series = await new WalletCashService(db).getWalletCashSeries(
        userId,
        5,
        new Date('2026-06-30T12:00:00Z'),
      );

      expect(series.map((point) => point.date)).toEqual([
        '2026-06-25',
        '2026-06-26',
        '2026-06-27',
        '2026-06-28',
        '2026-06-29',
        '2026-06-30',
      ]);
      expect(series.map((point) => point.total)).toEqual([1000, 1000, 1000, 1500, 1300, 1300]);
    });
  });

  it('uses America/Sao_Paulo calendar days at the UTC boundary', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      await db.insert(accounts).values({
        userId,
        name: 'Itaú',
        type: 'checking',
        currency: 'BRL',
        openingBalance: '1000.00',
        openingBalanceAnchorAt: ANCHOR,
      });

      const series = await new WalletCashService(db).getWalletCashSeries(
        userId,
        1,
        new Date('2026-07-01T02:30:00Z'),
      );
      expect(series.map((point) => point.date)).toEqual(['2026-06-29', '2026-06-30']);
    });
  });

  it('starts at the latest anchor inside the requested window', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [revenue] = await db
        .insert(accounts)
        .values({ userId, name: 'Revenue', type: 'revenue', currency: 'BRL' })
        .returning();
      const [firstWallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'First',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '1000.00',
          openingBalanceAnchorAt: ANCHOR,
        })
        .returning();
      await db.insert(accounts).values({
        userId,
        name: 'Second',
        type: 'checking',
        currency: 'BRL',
        openingBalance: '500.00',
        openingBalanceAnchorAt: new Date('2026-06-29T12:00:00Z'),
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: revenue.id,
        destinationAccountId: firstWallet.id,
        amount: '100.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Earlier movement',
        date: new Date('2026-06-28'),
        domainType: 'income_clt',
        isPaid: true,
        paidAt: AFTER,
      });

      const series = await new WalletCashService(db).getWalletCashSeries(
        userId,
        5,
        new Date('2026-06-30T12:00:00Z'),
      );
      expect(series.map((point) => point.date)).toEqual(['2026-06-29', '2026-06-30']);
      expect(series.map((point) => point.total)).toEqual([1600, 1600]);
    });
  });

  it('cancels wallet-to-wallet transfers and excludes internal family-loan rows', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [familyLoan] = await db
        .insert(accounts)
        .values({ userId, name: 'Célia', type: 'family_loan', currency: 'BRL' })
        .returning();
      const [firstWallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'First',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '1000.00',
          openingBalanceAnchorAt: ANCHOR,
        })
        .returning();
      const [secondWallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Second',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '200.00',
          openingBalanceAnchorAt: ANCHOR,
        })
        .returning();
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: firstWallet.id,
          destinationAccountId: secondWallet.id,
          amount: '300.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'Internal transfer',
          date: new Date('2026-06-28'),
          isPaid: true,
          paidAt: AFTER,
        },
        {
          userId,
          sourceAccountId: firstWallet.id,
          destinationAccountId: familyLoan.id,
          amount: '1534.50',
          currency: 'BRL',
          type: 'transfer',
          description: 'Internal family-loan ledger',
          date: new Date('2026-06-29'),
          domainType: 'family_loan_discount',
          isPaid: true,
          paidAt: AFTER,
        },
      ]);

      const series = await new WalletCashService(db).getWalletCashSeries(
        userId,
        5,
        new Date('2026-06-30T12:00:00Z'),
      );
      expect(series.every((point) => point.total === 1200)).toBe(true);
    });
  });

  it('is isolated to the requested user', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const otherUserId = await seedUser(db);
      await db.insert(accounts).values([
        {
          userId,
          name: 'Mine',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '1000.00',
          openingBalanceAnchorAt: ANCHOR,
        },
        {
          userId: otherUserId,
          name: 'Other',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '9999.00',
          openingBalanceAnchorAt: ANCHOR,
        },
      ]);

      const series = await new WalletCashService(db).getWalletCashSeries(
        userId,
        1,
        new Date('2026-06-30T12:00:00Z'),
      );
      expect(series.map((point) => point.total)).toEqual([1000, 1000]);
    });
  });

  it('uses exactly two read statements regardless of wallet count', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      await db.insert(accounts).values({
        userId,
        name: 'Wallet 0',
        type: 'checking',
        currency: 'BRL',
        openingBalance: '100.00',
        openingBalanceAnchorAt: ANCHOR,
      });

      const singleWallet = withQueryCounter(db);
      await new WalletCashService(singleWallet.counted).getWalletCashSeries(
        userId,
        5,
        new Date('2026-06-30T12:00:00Z'),
      );
      expect(singleWallet.queries()).toBe(2);

      await db.insert(accounts).values(
        Array.from({ length: 7 }, (_, index) => ({
          userId,
          name: `Wallet ${index + 1}`,
          type: 'checking' as const,
          currency: 'BRL',
          openingBalance: '100.00',
          openingBalanceAnchorAt: ANCHOR,
        })),
      );

      const manyWallets = withQueryCounter(db);
      await new WalletCashService(manyWallets.counted).getWalletCashSeries(
        userId,
        5,
        new Date('2026-06-30T12:00:00Z'),
      );
      expect(manyWallets.queries()).toBe(2);
    });
  });
});
