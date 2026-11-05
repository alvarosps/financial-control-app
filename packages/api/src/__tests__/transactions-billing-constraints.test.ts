import type { DbExecutor } from '@fc/db';
import { accounts, scheduledTransactions, transactions, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { expectDbError } from '../test/assert-db-error.ts';
import { withRollback } from '../test/with-rollback.ts';

async function seedWallet(db: DbExecutor) {
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `billing-chk-${Date.now()}-${Math.random()}@test.com`,
      name: 'billing chk',
      passwordHash: 'hashed',
    })
    .returning();
  const [wallet] = await db
    .insert(accounts)
    .values({ userId: user.id, name: 'wallet', type: 'checking' })
    .returning();
  return { user, wallet };
}

describe('transactions billing CHECK constraints', () => {
  it('keeps occurrence identity independent of a shared original purchase date', async () => {
    await withRollback(async (db) => {
      const { user, wallet } = await seedWallet(db);
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId: user.id,
          sourceAccountId: wallet.id,
          destinationAccountId: wallet.id,
          amount: '10.00',
          description: 'Series',
          frequency: 'monthly',
          startDate: new Date('2026-06-01'),
          purchaseDate: '2026-05-23',
          purchaseDateSource: 'institution',
        })
        .returning();
      const common = {
        userId: user.id,
        sourceAccountId: wallet.id,
        destinationAccountId: wallet.id,
        scheduledTransactionId: schedule.id,
        amount: '10.00',
        type: 'transfer' as const,
        description: 'Installment',
        purchaseDate: '2026-05-23',
        purchaseDateSource: 'institution' as const,
        billingYear: 2026,
      };
      const rows = await db
        .insert(transactions)
        .values([
          { ...common, date: new Date('2026-06-08'), billingMonth: 6 },
          { ...common, date: new Date('2026-07-08'), billingMonth: 7 },
        ])
        .returning();
      expect(rows).toHaveLength(2);
      await expectDbError(
        db
          .insert(transactions)
          .values({ ...common, date: new Date('2026-07-08'), billingMonth: 8 }),
        /tx_materialized_unique/,
      );
    });
  });

  it('rejects billing_month set without billing_year', async () => {
    await withRollback(async (db) => {
      const { user, wallet } = await seedWallet(db);
      await expectDbError(
        db.insert(transactions).values({
          userId: user.id,
          sourceAccountId: wallet.id,
          destinationAccountId: wallet.id,
          amount: '10.00',
          type: 'transfer',
          description: 'month without year',
          date: new Date('2026-07-01'),
          billingMonth: 6,
        }),
        /chk_transactions_billing_pair/,
      );
    });
  });

  it('rejects billing_year set without billing_month', async () => {
    await withRollback(async (db) => {
      const { user, wallet } = await seedWallet(db);
      await expectDbError(
        db.insert(transactions).values({
          userId: user.id,
          sourceAccountId: wallet.id,
          destinationAccountId: wallet.id,
          amount: '10.00',
          type: 'transfer',
          description: 'year without month',
          date: new Date('2026-07-01'),
          billingYear: 2026,
        }),
        /chk_transactions_billing_pair/,
      );
    });
  });

  it('rejects non-positive billing_year', async () => {
    await withRollback(async (db) => {
      const { user, wallet } = await seedWallet(db);
      await expectDbError(
        db.insert(transactions).values({
          userId: user.id,
          sourceAccountId: wallet.id,
          destinationAccountId: wallet.id,
          amount: '10.00',
          type: 'transfer',
          description: 'zero year',
          date: new Date('2026-07-01'),
          billingMonth: 6,
          billingYear: 0,
        }),
        /chk_transactions_billing_year_positive|date field value out of range/,
      );
    });
  });

  it('accepts a consistent billing pair', async () => {
    await withRollback(async (db) => {
      const { user, wallet } = await seedWallet(db);
      await expect(
        db.insert(transactions).values({
          userId: user.id,
          sourceAccountId: wallet.id,
          destinationAccountId: wallet.id,
          amount: '10.00',
          type: 'transfer',
          description: 'ok pair',
          date: new Date('2026-07-01'),
          billingMonth: 6,
          billingYear: 2026,
        }),
      ).resolves.not.toThrow();
    });
  });
});
