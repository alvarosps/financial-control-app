import { accounts, auditLog, monthClosings, transactions, userProfiles } from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

describe('reviewed balance adjustment', () => {
  it('preserves negative cash, records evidence and rejects stale revisions', () =>
    withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: `anchor-${crypto.randomUUID()}@test.local`, name: 'T', passwordHash: 'h' })
        .returning();
      const service = new AccountService(db);
      const wallet = await service.create(user.id, {
        name: 'Wallet',
        type: 'checking',
        currency: 'BRL',
      });
      const preview = await service.balanceAdjustmentPreview(user.id, wallet.id);
      await service.reanchorWallet(user.id, wallet.id, '-99.51', {
        expectedRevision: preview.revision,
        reason: 'Observed bank balance',
      });
      expect((await new WalletCashService(db).getWalletCash(user.id)).totalCash).toBe(-99.51);
      expect(
        await db
          .select()
          .from(auditLog)
          .where(
            and(eq(auditLog.userId, user.id), eq(auditLog.action, 'wallet_balance_adjustment')),
          ),
      ).toHaveLength(1);
      await expect(
        db.transaction((tx) =>
          new AccountService(tx).reanchorWallet(user.id, wallet.id, '0.00', {
            expectedRevision: preview.revision,
            reason: 'Old preview',
          }),
        ),
      ).rejects.toThrow('Balance changed');
      const updated = await service.balanceAdjustmentPreview(user.id, wallet.id);
      await service.reanchorWallet(user.id, wallet.id, '0.00', {
        expectedRevision: updated.revision,
        reason: 'Zero balance',
      });
      expect((await new WalletCashService(db).getWalletCash(user.id)).totalCash).toBe(0);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, user.id)),
      ).toHaveLength(0);
      const now = new Date();
      await db.insert(monthClosings).values({
        userId: user.id,
        month: now.getMonth() + 1,
        year: now.getFullYear(),
        status: 'closed',
      });
      const closedPreview = await service.balanceAdjustmentPreview(user.id, wallet.id);
      await expect(
        db.transaction((tx) =>
          new AccountService(tx).reanchorWallet(user.id, wallet.id, '50.00', {
            expectedRevision: closedPreview.revision,
            reason: 'Closed month',
          }),
        ),
      ).rejects.toThrow(/closed/i);
      expect((await new WalletCashService(db).getWalletCash(user.id)).totalCash).toBe(0);
      await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, wallet.id));
      await expect(service.balanceAdjustmentPreview(user.id, wallet.id)).rejects.toThrow(
        'active BRL',
      );
      await expect(
        service.balanceAdjustmentPreview(crypto.randomUUID(), wallet.id),
      ).rejects.toThrow();
    }));
});
