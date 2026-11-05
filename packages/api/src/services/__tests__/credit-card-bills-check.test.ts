import { accounts, creditCardBills, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { expectDbError } from '../../test/assert-db-error.ts';
import { withRollback } from '../../test/with-rollback.ts';

describe('credit_card_bills ccb_paid_consistency CHECK', () => {
  it('rejects paid_at set but paid_amount = 0', async () => {
    await withRollback(async (db) => {
      const [u] = await db
        .insert(userProfiles)
        .values({ email: 'ccb-check-1@test.com', name: 'Test', passwordHash: 'hash' })
        .returning();
      const [acct] = await db
        .insert(accounts)
        .values({ userId: u.id, name: 'card', type: 'credit_card', isActive: true })
        .returning();

      await expectDbError(
        db.insert(creditCardBills).values({
          creditCardAccountId: acct.id,
          month: 1,
          year: 2099,
          totalAmount: '100.00',
          status: 'paid',
          paidAt: new Date(),
          paidAmount: '0',
        }),
        /ccb_paid_consistency/i,
      );
    });
  });

  it('rejects paid_at null but paid_amount > 0', async () => {
    await withRollback(async (db) => {
      const [u] = await db
        .insert(userProfiles)
        .values({ email: 'ccb-check-2@test.com', name: 'Test', passwordHash: 'hash' })
        .returning();
      const [acct] = await db
        .insert(accounts)
        .values({ userId: u.id, name: 'card', type: 'credit_card', isActive: true })
        .returning();

      await expectDbError(
        db.insert(creditCardBills).values({
          creditCardAccountId: acct.id,
          month: 2,
          year: 2099,
          totalAmount: '100.00',
          status: 'open',
          paidAt: null,
          paidAmount: '50.00',
        }),
        /ccb_paid_consistency/i,
      );
    });
  });

  it('accepts paid bill with paid_at AND paid_amount > 0', async () => {
    await withRollback(async (db) => {
      const [u] = await db
        .insert(userProfiles)
        .values({ email: 'ccb-check-3@test.com', name: 'Test', passwordHash: 'hash' })
        .returning();
      const [acct] = await db
        .insert(accounts)
        .values({ userId: u.id, name: 'card', type: 'credit_card', isActive: true })
        .returning();
      const [row] = await db
        .insert(creditCardBills)
        .values({
          creditCardAccountId: acct.id,
          month: 3,
          year: 2099,
          totalAmount: '100.00',
          status: 'paid',
          paidAt: new Date(),
          paidAmount: '100.00',
        })
        .returning();
      expect(row.id).toBeDefined();
    });
  });
});
