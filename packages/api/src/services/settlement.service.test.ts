import type { DbExecutor } from '@fc/db';
import { accounts, scheduledTransactions, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { SettlementService } from './settlement.service.ts';

async function seedUser(db: DbExecutor): Promise<string> {
  const [u] = await db
    .insert(userProfiles)
    .values({
      email: `settle-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Test User',
      passwordHash: 'hashed',
    })
    .returning();
  return u.id;
}

describe('SettlementService', () => {
  it('settle redirects the income destination leg and stores BRL override', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [revenue] = await db
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
          sourceAccountId: revenue.id,
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

      const settlement = new SettlementService(db);
      const updated = await settlement.settle(userId, {
        transactionId: tx.id,
        walletAccountId: walletB.id,
        leg: 'destination',
        amountOverrideBrl: '5180.00',
      });

      expect(updated.isPaid).toBe(true);
      expect(updated.destinationAccountId).toBe(walletB.id);
      expect(updated.paidFromAccountId).toBe(walletB.id);
      expect(updated.currency).toBe('USD');
      expect(updated.amount).toBe(tx.amount);
      expect(updated.cashAmount).toBe('5180.00');
      expect(updated.settlementSource).toBe('manual');
    });
  });

  it('settle redirects the loan source leg without touching amount', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [loan] = await db
        .insert(accounts)
        .values({ userId, name: 'loan', type: 'loan', currency: 'BRL' })
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
          sourceAccountId: walletA.id,
          destinationAccountId: loan.id,
          amount: '900.00',
          currency: 'BRL',
          type: 'transfer',
          description: 'loan payment',
          date: new Date('2026-06-10'),
          domainType: 'loan_payment',
          isPaid: false,
        })
        .returning();

      const updated = await new SettlementService(db).settle(userId, {
        transactionId: tx.id,
        walletAccountId: walletB.id,
        leg: 'source',
      });

      expect(updated.isPaid).toBe(true);
      expect(updated.sourceAccountId).toBe(walletB.id);
      expect(Number(updated.amount)).toBeCloseTo(900, 2);
      expect(updated.currency).toBe('BRL');
    });
  });

  it('settle rejects a wallet that is not a checking/savings account', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [revenue] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'USD' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'A', type: 'checking', currency: 'BRL' })
        .returning();
      // A revenue account is NOT a valid wallet destination.
      const [badWallet] = await db
        .insert(accounts)
        .values({ userId, name: 'bad', type: 'revenue', currency: 'BRL' })
        .returning();
      const [tx] = await db
        .insert(transactions)
        .values({
          userId,
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

      await expect(
        new SettlementService(db).settle(userId, {
          transactionId: tx.id,
          walletAccountId: badWallet.id,
          leg: 'destination',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  // Cross-tenant isolation: the userId predicate on every settle/unsettle query
  // is the SOLE runtime barrier (RLS is decorative — the app connects as
  // superuser). Pin it so a regression that drops the predicate is caught.
  describe('cross-tenant isolation', () => {
    it("settle(userB) cannot settle userA's transaction (NOT_FOUND)", async () => {
      await withRollback(async (db) => {
        const userA = await seedUser(db);
        const userB = await seedUser(db);
        const [revenueA] = await db
          .insert(accounts)
          .values({ userId: userA, name: 'revA', type: 'revenue', currency: 'BRL' })
          .returning();
        const [walletA] = await db
          .insert(accounts)
          .values({ userId: userA, name: 'walA', type: 'checking', currency: 'BRL' })
          .returning();
        const [walletB] = await db
          .insert(accounts)
          .values({ userId: userB, name: 'walB', type: 'checking', currency: 'BRL' })
          .returning();
        const [txA] = await db
          .insert(transactions)
          .values({
            userId: userA,
            sourceAccountId: revenueA.id,
            destinationAccountId: walletA.id,
            amount: '1000.00',
            currency: 'BRL',
            type: 'deposit',
            description: 'income A',
            date: new Date('2026-06-05'),
            domainType: 'income_pj',
            isPaid: false,
          })
          .returning();

        await expect(
          new SettlementService(db).settle(userB, {
            transactionId: txA.id,
            walletAccountId: walletB.id,
            leg: 'destination',
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });

        // userA's transaction is untouched.
        const [after] = await db.select().from(transactions).where(eq(transactions.id, txA.id));
        expect(after.isPaid).toBe(false);
      });
    });

    it("settle(userA) cannot redirect into userB's wallet (NOT_FOUND)", async () => {
      await withRollback(async (db) => {
        const userA = await seedUser(db);
        const userB = await seedUser(db);
        const [revenueA] = await db
          .insert(accounts)
          .values({ userId: userA, name: 'revA', type: 'revenue', currency: 'BRL' })
          .returning();
        const [walletA] = await db
          .insert(accounts)
          .values({ userId: userA, name: 'walA', type: 'checking', currency: 'BRL' })
          .returning();
        const [walletB] = await db
          .insert(accounts)
          .values({ userId: userB, name: 'walB', type: 'checking', currency: 'BRL' })
          .returning();
        const [txA] = await db
          .insert(transactions)
          .values({
            userId: userA,
            sourceAccountId: revenueA.id,
            destinationAccountId: walletA.id,
            amount: '1000.00',
            currency: 'BRL',
            type: 'deposit',
            description: 'income A',
            date: new Date('2026-06-05'),
            domainType: 'income_pj',
            isPaid: false,
          })
          .returning();

        // userA owns the tx but the wallet belongs to userB — the wallet load is
        // userId-scoped, so it resolves no row and the redirect is refused.
        await expect(
          new SettlementService(db).settle(userA, {
            transactionId: txA.id,
            walletAccountId: walletB.id,
            leg: 'destination',
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });

        const [after] = await db.select().from(transactions).where(eq(transactions.id, txA.id));
        expect(after.isPaid).toBe(false);
        expect(after.destinationAccountId).toBe(walletA.id);
      });
    });

    it("unsettle(userB) cannot unsettle userA's paid transaction (NOT_FOUND)", async () => {
      await withRollback(async (db) => {
        const userA = await seedUser(db);
        const userB = await seedUser(db);
        const [revenueA] = await db
          .insert(accounts)
          .values({ userId: userA, name: 'revA', type: 'revenue', currency: 'BRL' })
          .returning();
        const [walletA] = await db
          .insert(accounts)
          .values({ userId: userA, name: 'walA', type: 'checking', currency: 'BRL' })
          .returning();
        const [txA] = await db
          .insert(transactions)
          .values({
            userId: userA,
            sourceAccountId: revenueA.id,
            destinationAccountId: walletA.id,
            amount: '1000.00',
            currency: 'BRL',
            type: 'deposit',
            description: 'income A',
            date: new Date('2026-06-05'),
            domainType: 'income_pj',
            isPaid: true,
            paidFromAccountId: walletA.id,
            paidAt: new Date(),
          })
          .returning();

        await expect(new SettlementService(db).unsettle(userB, txA.id)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });

        // userA's paid transaction is untouched.
        const [after] = await db.select().from(transactions).where(eq(transactions.id, txA.id));
        expect(after.isPaid).toBe(true);
      });
    });
  });

  it('unsettle restores schedule defaults', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [revenue] = await db
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
      const [sched] = await db
        .insert(scheduledTransactions)
        .values({
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: walletA.id,
          amount: '1000.00',
          currency: 'USD',
          description: 'x',
          frequency: 'biweekly',
          startDate: new Date('2026-05-22'),
          startingOccurrence: 1,
          domainType: 'income_pj',
        })
        .returning();
      const [tx] = await db
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: walletB.id,
          amount: '5180.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'income',
          date: new Date('2026-06-05'),
          domainType: 'income_pj',
          isPaid: true,
          scheduledTransactionId: sched.id,
        })
        .returning();

      const updated = await new SettlementService(db).unsettle(userId, tx.id);

      expect(updated.isPaid).toBe(false);
      expect(updated.destinationAccountId).toBe(walletA.id);
      expect(updated.currency).toBe('USD');
      expect(Number(updated.amount)).toBeCloseTo(1000, 2);
      expect(updated.exchangeRate).toBeNull();
    });
  });
});
