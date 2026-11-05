import type { DbExecutor } from '@fc/db';
import { accounts, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);

async function seedUser(db: DbExecutor): Promise<string> {
  const [u] = await db
    .insert(userProfiles)
    .values({
      email: `income-router-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Test User',
      passwordHash: 'hashed',
    })
    .returning();
  return u.id;
}

describe('income.markOccurrenceAsReceived guard', () => {
  it('rejects a transactionId that is not an income occurrence', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [walletA] = await db
        .insert(accounts)
        .values({ userId, name: 'A', type: 'checking', currency: 'BRL' })
        .returning();
      const [walletB] = await db
        .insert(accounts)
        .values({ userId, name: 'B', type: 'checking', currency: 'BRL' })
        .returning();
      const [loanAcct] = await db
        .insert(accounts)
        .values({ userId, name: 'loan', type: 'loan', currency: 'BRL' })
        .returning();
      // A loan payment is user-owned but NOT an income row.
      const [tx] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: walletA.id,
          destinationAccountId: loanAcct.id,
          amount: '900.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'loan payment',
          date: new Date('2026-06-10'),
          domainType: 'loan_payment',
          isPaid: false,
        })
        .returning();

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      await expect(
        caller.income.markOccurrenceAsReceived({
          transactionId: tx.id,
          paidToAccountId: walletB.id,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('accepts an unpaid income occurrence', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
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
          currency: 'BRL',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: false,
        })
        .returning();

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      const updated = await caller.income.markOccurrenceAsReceived({
        transactionId: tx.id,
        paidToAccountId: walletB.id,
      });
      expect(updated.isPaid).toBe(true);
      expect(updated.destinationAccountId).toBe(walletB.id);
    });
  });

  it('rejects a forex (USD) occurrence settled without amountBrl', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
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
          description: 'income usd',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: false,
        })
        .returning();

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      await expect(
        caller.income.markOccurrenceAsReceived({
          transactionId: tx.id,
          paidToAccountId: walletB.id,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('settles a forex (USD) occurrence with amountBrl, storing the BRL value', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
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
          description: 'income usd',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: false,
        })
        .returning();

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      const updated = await caller.income.markOccurrenceAsReceived({
        transactionId: tx.id,
        paidToAccountId: walletB.id,
        amountBrl: '5250.00',
      });
      expect(updated.isPaid).toBe(true);

      const [row] = await db
        .select({
          amount: transactions.amount,
          currency: transactions.currency,
          cashAmount: transactions.cashAmount,
        })
        .from(transactions)
        .where(eq(transactions.id, tx.id));
      expect(row.currency).toBe('USD');
      expect(row.amount).toBe(tx.amount);
      expect(row.cashAmount).toBe('5250.00');
    });
  });
});

describe('income.editReceivedAmount', () => {
  it('edits a paid income row amount to the realized BRL value', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
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
          amount: '14000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'income usd',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: false,
        })
        .returning();

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      // Settle to obtain a paid BRL row.
      await caller.income.markOccurrenceAsReceived({
        transactionId: tx.id,
        paidToAccountId: walletB.id,
        amountBrl: '14250.00',
      });

      const result = await caller.income.editReceivedAmount({
        transactionId: tx.id,
        amountBrl: '13864.16',
      });
      expect(result.success).toBe(true);

      const [row] = await db
        .select({
          amount: transactions.amount,
          currency: transactions.currency,
          cashAmount: transactions.cashAmount,
        })
        .from(transactions)
        .where(eq(transactions.id, tx.id));
      expect(row.amount).toBe('14000.00');
      expect(row.cashAmount).toBe('13864.16');
      expect(row.currency).toBe(tx.currency);
    });
  });

  it('reports affectsCurrentBalance based on the wallet anchor', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Conta', type: 'checking', currency: 'BRL' })
        .returning();
      const [tx] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
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

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      // Settle so the row becomes paid (paidAt = now) on the BRL wallet.
      await caller.income.markOccurrenceAsReceived({
        transactionId: tx.id,
        paidToAccountId: wallet.id,
      });

      // (a) wallet anchored to the PAST → the paid row is after the anchor.
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
        .where(eq(accounts.id, wallet.id));
      const past = await caller.income.editReceivedAmount({
        transactionId: tx.id,
        amountBrl: '1100.00',
      });
      expect(past.affectsCurrentBalance).toBe(true);

      // (b) wallet anchored to the FUTURE (after the row's paid_at) → no effect.
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2999-01-01T00:00:00Z') })
        .where(eq(accounts.id, wallet.id));
      const now = await caller.income.editReceivedAmount({
        transactionId: tx.id,
        amountBrl: '1200.00',
      });
      expect(now.affectsCurrentBalance).toBe(false);
    });
  });

  it('reports affectsCurrentBalance=false for a paid occurrence dated in the future', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Conta', type: 'checking', currency: 'BRL' })
        .returning();
      // Future-dated row, already marked paid (paid_at far past, anchor before it).
      const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      const [tx] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: wallet.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'income',
          date: futureDate,
          domainType: 'income_pj',
          isPaid: true,
          paidAt: new Date('2026-01-01T00:00:00Z'),
        })
        .returning();
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
        .where(eq(accounts.id, wallet.id));

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      // date > now → WalletCashService excludes it via date<=asOf, so the toast must not fire.
      const result = await caller.income.editReceivedAmount({
        transactionId: tx.id,
        amountBrl: '1100.00',
      });
      expect(result.affectsCurrentBalance).toBe(false);
    });
  });

  it('reports affectsCurrentBalance=true for a past-dated paid row when the wallet anchor is null', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      // No openingBalanceAnchorAt → defaults to EPOCH, so any paid_at counts.
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Conta', type: 'checking', currency: 'BRL' })
        .returning();
      const [tx] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
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

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      const result = await caller.income.editReceivedAmount({
        transactionId: tx.id,
        amountBrl: '1100.00',
      });
      expect(result.affectsCurrentBalance).toBe(true);
    });
  });

  it('rejects an unpaid income row', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      const [walletA] = await db
        .insert(accounts)
        .values({ userId, name: 'A', type: 'checking', currency: 'BRL' })
        .returning();
      const [tx] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: walletA.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: false,
        })
        .returning();

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      await expect(
        caller.income.editReceivedAmount({ transactionId: tx.id, amountBrl: '900.00' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('rejects a reversed income row', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      const [walletA] = await db
        .insert(accounts)
        .values({ userId, name: 'A', type: 'checking', currency: 'BRL' })
        .returning();
      const [tx] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: rev.id,
          destinationAccountId: walletA.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: true,
          isReversed: true,
        })
        .returning();

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      await expect(
        caller.income.editReceivedAmount({ transactionId: tx.id, amountBrl: '900.00' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('rejects a non-income transaction', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [walletA] = await db
        .insert(accounts)
        .values({ userId, name: 'A', type: 'checking', currency: 'BRL' })
        .returning();
      const [loanAcct] = await db
        .insert(accounts)
        .values({ userId, name: 'loan', type: 'loan', currency: 'BRL' })
        .returning();
      const [tx] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: walletA.id,
          destinationAccountId: loanAcct.id,
          amount: '900.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'loan payment',
          date: new Date('2026-06-10'),
          domainType: 'loan_payment',
          isPaid: true,
        })
        .returning();

      const caller = createCaller({
        db,
        userId,
        profileCache: createRequestProfileCache(db),
      });

      await expect(
        caller.income.editReceivedAmount({ transactionId: tx.id, amountBrl: '900.00' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it("rejects another user's transaction id", async () => {
    await withRollback(async (db) => {
      const ownerId = await seedUser(db);
      const intruderId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId: ownerId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      const [walletA] = await db
        .insert(accounts)
        .values({ userId: ownerId, name: 'A', type: 'checking', currency: 'BRL' })
        .returning();
      const [tx] = await db
        .insert(transactions)
        .values({
          userId: ownerId,
          sourceAccountId: rev.id,
          destinationAccountId: walletA.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: true,
        })
        .returning();

      const caller = createCaller({
        db,
        userId: intruderId,
        profileCache: createRequestProfileCache(db),
      });

      await expect(
        caller.income.editReceivedAmount({ transactionId: tx.id, amountBrl: '900.00' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
