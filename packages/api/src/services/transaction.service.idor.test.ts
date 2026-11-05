import type { DbExecutor } from '@fc/db';
import { accounts, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { TransactionService } from './transaction.service.ts';

async function seedUser(db: DbExecutor, email: string) {
  const accountService = new AccountService(db);
  const [user] = await db
    .insert(userProfiles)
    .values({ email, name: email, passwordHash: 'hashed' })
    .returning();
  const checking = await accountService.create(user.id, {
    name: 'Checking',
    type: 'checking',
    currency: 'BRL',
  });
  const revenue = await accountService.create(user.id, {
    name: 'Revenue',
    type: 'revenue',
    currency: 'BRL',
  });
  await db
    .update(accounts)
    .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
    .where(eq(accounts.id, checking.id));
  return { user, checking, revenue };
}

async function seedPaidDepositFor(
  service: TransactionService,
  userId: string,
  revenueId: string,
  checkingId: string,
) {
  const tx = await service.create(userId, {
    sourceAccountId: revenueId,
    destinationAccountId: checkingId,
    amount: '1000.00',
    description: 'Test income',
    date: new Date('2026-03-15'),
  });
  return service.markAsPaid(userId, tx.id, checkingId);
}

describe('TransactionService IDOR protection', () => {
  describe('markAsUnpaid', () => {
    it('throws NotFoundError when a user tries to unpay a transaction owned by another user', async () => {
      await withRollback(async (db) => {
        const service = new TransactionService(db);
        const a = await seedUser(db, 'idor-owner@test.com');
        const b = await seedUser(db, 'idor-attacker@test.com');

        const paidTx = await seedPaidDepositFor(service, a.user.id, a.revenue.id, a.checking.id);

        await expect(service.markAsUnpaid(b.user.id, paidTx.id)).rejects.toMatchObject({
          name: 'NotFoundError',
        });

        const [after] = await db.select().from(transactions).where(eq(transactions.id, paidTx.id));
        expect(after.isPaid).toBe(true);
        expect(after.paidFromAccountId).toBe(a.checking.id);
      });
    });

    it('succeeds when the owner unpays their own transaction', async () => {
      await withRollback(async (db) => {
        const service = new TransactionService(db);
        const a = await seedUser(db, 'idor-owner2@test.com');
        const paidTx = await seedPaidDepositFor(service, a.user.id, a.revenue.id, a.checking.id);

        const result = await service.markAsUnpaid(a.user.id, paidTx.id);

        expect(result.isPaid).toBe(false);
        expect(result.paidAt).toBeNull();
        expect(result.paidFromAccountId).toBeNull();
      });
    });

    it('throws NotFoundError when the transaction does not exist at all', async () => {
      await withRollback(async (db) => {
        const service = new TransactionService(db);
        const a = await seedUser(db, 'idor-missing@test.com');
        await expect(
          service.markAsUnpaid(a.user.id, '00000000-0000-0000-0000-000000000000'),
        ).rejects.toMatchObject({ name: 'NotFoundError' });
      });
    });
  });

  describe('markAsPaid', () => {
    it('throws NotFoundError when a user tries to pay a transaction owned by another user', async () => {
      await withRollback(async (db) => {
        const service = new TransactionService(db);
        const a = await seedUser(db, 'idor-pay-owner@test.com');
        const b = await seedUser(db, 'idor-pay-attacker@test.com');

        const tx = await service.create(a.user.id, {
          sourceAccountId: a.revenue.id,
          destinationAccountId: a.checking.id,
          amount: '500.00',
          description: 'Pending income',
          date: new Date('2026-03-15'),
        });

        await expect(service.markAsPaid(b.user.id, tx.id, b.checking.id)).rejects.toMatchObject({
          name: 'NotFoundError',
        });

        const [after] = await db.select().from(transactions).where(eq(transactions.id, tx.id));
        expect(after.isPaid).toBe(false);
      });
    });
  });
});
