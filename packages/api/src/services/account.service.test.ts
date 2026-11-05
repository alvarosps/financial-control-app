import type { DbExecutor } from '@fc/db';
import { accounts, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

async function seedUser(db: DbExecutor): Promise<string> {
  const [u] = await db
    .insert(userProfiles)
    .values({
      email: `acc-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Test User',
      passwordHash: 'hashed',
    })
    .returning();
  return u.id;
}

const TEST_USER = {
  email: 'account-test@example.com',
  name: 'Account Test User',
  passwordHash: 'hashed',
};

const TEST_USER_2 = {
  email: 'account-test-2@example.com',
  name: 'Account Test User 2',
  passwordHash: 'hashed',
};

describe('AccountService', () => {
  describe('create', () => {
    it('creates a checking account', async () => {
      await withRollback(async (db) => {
        const service = new AccountService(db);
        const [user] = await db.insert(userProfiles).values(TEST_USER).returning();

        const account = await service.create(user.id, {
          name: 'Main Checking',
          type: 'checking',
          currency: 'BRL',
        });

        expect(account.name).toBe('Main Checking');
        expect(account.type).toBe('checking');
        expect(Number(account.currentBalance)).toBe(0);
        expect(account.isActive).toBe(true);
        expect(account.userId).toBe(user.id);
      });
    });

    it('creates a credit card account', async () => {
      await withRollback(async (db) => {
        const service = new AccountService(db);
        const [user] = await db.insert(userProfiles).values(TEST_USER).returning();

        const account = await service.create(user.id, {
          name: 'My Credit Card',
          type: 'credit_card',
          currency: 'BRL',
          overdraftLimit: '5000.00',
        });

        expect(account.name).toBe('My Credit Card');
        expect(account.type).toBe('credit_card');
        expect(account.overdraftLimit).toBe('5000.00');
      });
    });
  });

  describe('listByUser', () => {
    it('lists accounts for a user', async () => {
      await withRollback(async (db) => {
        const service = new AccountService(db);
        const [user] = await db.insert(userProfiles).values(TEST_USER).returning();

        await service.create(user.id, { name: 'Account 1', type: 'checking', currency: 'BRL' });
        await service.create(user.id, { name: 'Account 2', type: 'savings', currency: 'BRL' });

        const list = await service.listByUser(user.id);

        expect(list).toHaveLength(2);
      });
    });

    it('lists only active accounts', async () => {
      await withRollback(async (db) => {
        const service = new AccountService(db);
        const [user] = await db.insert(userProfiles).values(TEST_USER).returning();

        const a1 = await service.create(user.id, {
          name: 'Active',
          type: 'checking',
          currency: 'BRL',
        });
        const a2 = await service.create(user.id, {
          name: 'Inactive',
          type: 'savings',
          currency: 'BRL',
        });

        await service.deactivate(user.id, a2.id);

        const list = await service.listByUser(user.id);

        expect(list).toHaveLength(1);
        expect(list[0].id).toBe(a1.id);
      });
    });
  });

  describe('getById', () => {
    it('gets account by id with ownership check', async () => {
      await withRollback(async (db) => {
        const service = new AccountService(db);
        const [user] = await db.insert(userProfiles).values(TEST_USER).returning();
        const created = await service.create(user.id, {
          name: 'My Account',
          type: 'checking',
          currency: 'BRL',
        });

        const found = await service.getById(user.id, created.id);

        expect(found.id).toBe(created.id);
        expect(found.name).toBe('My Account');
      });
    });

    it("throws when accessing another user's account", async () => {
      await withRollback(async (db) => {
        const service = new AccountService(db);
        const [user1] = await db.insert(userProfiles).values(TEST_USER).returning();
        const [user2] = await db.insert(userProfiles).values(TEST_USER_2).returning();

        const account = await service.create(user1.id, {
          name: 'User1 Account',
          type: 'checking',
          currency: 'BRL',
        });

        await expect(service.getById(user2.id, account.id)).rejects.toThrow('Conta não encontrada');
      });
    });
  });

  describe('update', () => {
    it('updates account name', async () => {
      await withRollback(async (db) => {
        const service = new AccountService(db);
        const [user] = await db.insert(userProfiles).values(TEST_USER).returning();
        const account = await service.create(user.id, {
          name: 'Old Name',
          type: 'checking',
          currency: 'BRL',
        });

        const updated = await service.update(user.id, account.id, { name: 'New Name' });

        expect(updated.name).toBe('New Name');
      });
    });

    it('rejects editing an archived credit card', async () => {
      await withRollback(async (db) => {
        const service = new AccountService(db);
        const userId = await seedUser(db);
        const card = await service.create(userId, {
          name: 'Archived Card',
          type: 'credit_card',
          currency: 'BRL',
        });
        await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, card.id));

        await expect(service.update(userId, card.id, { name: 'Changed' })).rejects.toMatchObject({
          code: 'CONFLICT',
          message: 'CARD_ARCHIVED',
        });
      });
    });
  });

  describe('deactivate', () => {
    it('deactivates account', async () => {
      await withRollback(async (db) => {
        const service = new AccountService(db);
        const [user] = await db.insert(userProfiles).values(TEST_USER).returning();
        const account = await service.create(user.id, {
          name: 'To Deactivate',
          type: 'checking',
          currency: 'BRL',
        });

        const deactivated = await service.deactivate(user.id, account.id);

        expect(deactivated.isActive).toBe(false);
      });
    });
  });

  describe('recalculateBalance', () => {
    it('returns 0 balance with no transactions', async () => {
      await withRollback(async (db) => {
        const service = new AccountService(db);
        const [user] = await db.insert(userProfiles).values(TEST_USER).returning();
        const account = await service.create(user.id, {
          name: 'Empty Account',
          type: 'checking',
          currency: 'BRL',
        });

        const balance = await service.recalculateBalance(account.id);

        expect(balance).toBe('0.00');
      });
    });
  });

  describe('getCreditCardChildrenMap', () => {
    it('maps each parent card to its active child card ids', async () => {
      await withRollback(async (db) => {
        const svc = new AccountService(db);
        const [user] = await db
          .insert(userProfiles)
          .values({ email: 'children-map@test.com', name: 'T', passwordHash: 'h' })
          .returning();

        const parent = await svc.create(user.id, {
          name: 'Azul',
          type: 'credit_card',
          currency: 'BRL',
        });
        const child = await svc.create(user.id, {
          name: 'Azul Camila',
          type: 'credit_card',
          currency: 'BRL',
          parentAccountId: parent.id,
        });
        await svc.create(user.id, { name: 'Standalone', type: 'credit_card', currency: 'BRL' });

        const map = await svc.getCreditCardChildrenMap(user.id);
        expect(map.get(parent.id)).toEqual([child.id]);
        expect(map.has(child.id)).toBe(false);
      });
    });
  });
});

describe('AccountService wallet helpers', () => {
  it('listWallets returns only active checking accounts', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      await db.insert(accounts).values([
        { userId, name: 'Itaú', type: 'checking', currency: 'BRL' },
        { userId, name: 'Poupança', type: 'savings', currency: 'BRL' },
        { userId, name: 'Cartão', type: 'credit_card', currency: 'BRL' },
        { userId, name: 'Inativa', type: 'checking', currency: 'BRL', isActive: false },
      ]);
      const wallets = await new AccountService(db).listWallets(userId);
      expect(wallets.map((w) => w.name)).toEqual(['Itaú']);
    });
  });

  it('setDefaultWallet makes exactly one default and clears the previous one', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [a] = await db
        .insert(accounts)
        .values({ userId, name: 'A', type: 'checking', currency: 'BRL', isDefaultWallet: true })
        .returning();
      const [b] = await db
        .insert(accounts)
        .values({ userId, name: 'B', type: 'checking', currency: 'BRL' })
        .returning();

      const service = new AccountService(db);
      await service.setDefaultWallet(userId, b.id);

      const rows = await db.select().from(accounts).where(eq(accounts.userId, userId));
      expect(rows.find((r) => r.id === a.id)?.isDefaultWallet).toBe(false);
      expect(rows.find((r) => r.id === b.id)?.isDefaultWallet).toBe(true);

      const def = await service.getDefaultWallet(userId);
      expect(def?.id).toBe(b.id);
    });
  });

  it('setDefaultWallet rejects a non-checking account', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [card] = await db
        .insert(accounts)
        .values({ userId, name: 'Cartão', type: 'credit_card', currency: 'BRL' })
        .returning();
      await expect(new AccountService(db).setDefaultWallet(userId, card.id)).rejects.toMatchObject({
        name: 'NotFoundError',
      });
    });
  });
});

describe('AccountService.reanchorWallet', () => {
  const PAST = new Date('2020-01-01T00:00:00Z');

  it('re-anchors so cash equals the new value, baking old paid movements into opening', async () => {
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
          openingBalance: '300.00',
          openingBalanceAnchorAt: PAST,
        })
        .returning();

      // Paid movements settled before the re-anchor — must NOT double-count afterwards.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: rev.id,
        destinationAccountId: wallet.id,
        amount: '500.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'salary',
        date: new Date('2020-02-01'),
        domainType: 'income_clt',
        isPaid: true,
        paidAt: new Date('2020-02-01T00:00:00Z'),
      });
      await db.insert(transactions).values({
        userId,
        sourceAccountId: wallet.id,
        destinationAccountId: exp.id,
        amount: '200.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'bill',
        date: new Date('2020-02-05'),
        domainType: 'recurring_bill',
        isPaid: true,
        paidAt: new Date('2020-02-05T00:00:00Z'),
      });

      await new AccountService(db).reanchorWallet(userId, wallet.id, '1000.00');

      const overview = await new WalletCashService(db).getWalletCash(userId);
      const w = overview.wallets.find((x) => x.id === wallet.id);
      expect(w?.cash).toBeCloseTo(1000, 2);
    });
  });

  it('adds a new paid movement settled after the re-anchor on top of the new cash', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [rev] = await db
        .insert(accounts)
        .values({ userId, name: 'rev', type: 'revenue', currency: 'BRL' })
        .returning();
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '0.00',
          openingBalanceAnchorAt: PAST,
        })
        .returning();

      await new AccountService(db).reanchorWallet(userId, wallet.id, '1000.00');

      // Read the persisted anchor and place the movement deterministically AFTER it.
      // WalletCashService counts paid movements with paid_at > anchor (strict), so a
      // same-millisecond paidAt would otherwise be excluded under fast runs/fake timers.
      const [anchored] = await db
        .select({ anchor: accounts.openingBalanceAnchorAt })
        .from(accounts)
        .where(eq(accounts.id, wallet.id));
      const afterAnchor = new Date((anchored?.anchor ?? new Date()).getTime() + 1000);

      // Inserted AFTER the re-anchor — its paidAt is strictly after the anchor.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: rev.id,
        destinationAccountId: wallet.id,
        amount: '250.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'extra income',
        date: new Date(),
        domainType: 'income_clt',
        isPaid: true,
        paidAt: afterAnchor,
        settlementDate: afterAnchor,
        settlementSource: 'manual',
        cashAmount: '250.00',
      });

      const overview = await new WalletCashService(db).getWalletCash(userId, afterAnchor);
      const w = overview.wallets.find((x) => x.id === wallet.id);
      expect(w?.cash).toBeCloseTo(1250, 2);
    });
  });

  it('supports a negative re-anchor value (overdraft)', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId,
          name: 'Itaú',
          type: 'checking',
          currency: 'BRL',
          openingBalance: '0.00',
          openingBalanceAnchorAt: PAST,
        })
        .returning();

      await new AccountService(db).reanchorWallet(userId, wallet.id, '-50.00');

      const overview = await new WalletCashService(db).getWalletCash(userId);
      const w = overview.wallets.find((x) => x.id === wallet.id);
      expect(w?.cash).toBeCloseTo(-50, 2);
    });
  });

  it("throws NotFoundError for another user's wallet", async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const otherUserId = await seedUser(db);
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'Itaú', type: 'checking', currency: 'BRL' })
        .returning();

      await expect(
        new AccountService(db).reanchorWallet(otherUserId, wallet.id, '1000.00'),
      ).rejects.toMatchObject({ name: 'NotFoundError' });
    });
  });

  it('rejects a non-checking account', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [card] = await db
        .insert(accounts)
        .values({ userId, name: 'Cartão', type: 'credit_card', currency: 'BRL' })
        .returning();

      await expect(
        new AccountService(db).reanchorWallet(userId, card.id, '1000.00'),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('rejects a non-BRL wallet (cash tracking is BRL-only)', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      const [wallet] = await db
        .insert(accounts)
        .values({ userId, name: 'USD Wallet', type: 'checking', currency: 'USD' })
        .returning();

      await expect(
        new AccountService(db).reanchorWallet(userId, wallet.id, '100.00'),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
});
