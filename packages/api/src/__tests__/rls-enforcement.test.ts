import type { DbExecutor } from '@fc/db';
import { accounts, creditCardBills, transactions, userProfiles } from '@fc/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { expectDbError } from '../test/assert-db-error.ts';
import { withRollback } from '../test/with-rollback.ts';

/**
 * THE RLS enforcement proof: connected with the app_user role and the GUC of
 * user A, a SELECT with NO WHERE clause on transactions returns only A's rows,
 * and cross-tenant writes are rejected by the owner guard or WITH CHECK.
 *
 * Uses `SET LOCAL ROLE app_user` inside the withRollback transaction: the
 * superuser test connection temporarily BECOMES the non-superuser role (RLS
 * applies to current_user), and the final rollback reverts both the role and
 * the GUC. No app_user login/password needed.
 */
async function seedTenant(db: DbExecutor, label: string) {
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `rls-${label}-${Date.now()}-${Math.random()}@test.com`,
      name: `rls ${label}`,
      passwordHash: 'hashed',
    })
    .returning();

  const [wallet] = await db
    .insert(accounts)
    .values({ userId: user.id, name: `${label} wallet`, type: 'checking' })
    .returning();

  const [card] = await db
    .insert(accounts)
    .values({ userId: user.id, name: `${label} card`, type: 'credit_card' })
    .returning();

  await db.insert(transactions).values({
    userId: user.id,
    sourceAccountId: wallet.id,
    destinationAccountId: wallet.id,
    amount: '10.00',
    type: 'deposit',
    description: `${label} seed tx`,
    date: new Date('2026-07-01'),
  });

  await db.insert(creditCardBills).values({
    creditCardAccountId: card.id,
    month: 7,
    year: 2026,
    totalAmount: '100.00',
  });

  return { user, wallet, card };
}

describe('RLS enforcement as app_user', () => {
  it('SELECT without WHERE returns only the GUC user rows; cross-tenant INSERT is rejected', async () => {
    await withRollback(async (db) => {
      const a = await seedTenant(db, 'a');
      const b = await seedTenant(db, 'b');

      // Become the runtime role with user A's identity.
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', ${a.user.id}, true)`);

      const visibleTx = await db.select().from(transactions);
      expect(visibleTx).toHaveLength(1);
      expect(visibleTx[0]?.userId).toBe(a.user.id);

      const visibleBills = await db.select().from(creditCardBills);
      expect(visibleBills).toHaveLength(1);
      expect(visibleBills[0]?.creditCardAccountId).toBe(a.card.id);

      const visibleAccounts = await db.select().from(accounts);
      expect(visibleAccounts).toHaveLength(2);

      await expectDbError(
        db.insert(transactions).values({
          userId: b.user.id,
          sourceAccountId: b.wallet.id,
          destinationAccountId: b.wallet.id,
          amount: '66.00',
          type: 'deposit',
          description: 'forged cross-tenant row',
          date: new Date('2026-07-02'),
        }),
        /row-level security|Financial period owner mismatch/,
      );
    });
  });

  it('switching the GUC to user B flips visibility (same connection)', async () => {
    await withRollback(async (db) => {
      const a = await seedTenant(db, 'a2');
      const b = await seedTenant(db, 'b2');

      await db.execute(sql`SET LOCAL ROLE app_user`);

      await db.execute(sql`SELECT set_config('app.current_user_id', ${a.user.id}, true)`);
      const asA = await db.select().from(transactions);
      expect(asA).toHaveLength(1);
      expect(asA[0]?.userId).toBe(a.user.id);

      await db.execute(sql`SELECT set_config('app.current_user_id', ${b.user.id}, true)`);
      const asB = await db.select().from(transactions);
      expect(asB).toHaveLength(1);
      expect(asB[0]?.userId).toBe(b.user.id);
    });
  });
});
