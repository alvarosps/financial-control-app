import type { DbExecutor } from '@fc/db';
import { accounts, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

async function seedUser(db: DbExecutor): Promise<string> {
  const [u] = await db
    .insert(userProfiles)
    .values({
      email: `wo-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'T',
      passwordHash: 'h',
    })
    .returning();
  return u.id;
}

describe('walletsOverview composition', () => {
  it('returns wallets with cash and the user total', async () => {
    await withRollback(async (db) => {
      const userId = await seedUser(db);
      await db.insert(accounts).values({
        userId,
        name: 'Itaú',
        type: 'checking',
        currency: 'BRL',
        openingBalance: '-14830.46',
        openingBalanceAnchorAt: new Date('2026-06-01T00:00:00Z'),
        isDefaultWallet: true,
        overdraftLimit: '20000.00',
      });

      const accountService = new AccountService(db);
      const walletCash = new WalletCashService(db);
      const wallets = await accountService.listWallets(userId);
      const overview = await walletCash.getWalletCash(userId, new Date('2026-06-04'));

      expect(wallets).toHaveLength(1);
      expect(overview.totalCash).toBeCloseTo(-14830.46, 2);
      expect(overview.wallets[0].overdraftLimit).toBe('20000.00');
    });
  });
});
