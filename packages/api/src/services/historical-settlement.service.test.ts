import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounts, transactions, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { HistoricalSettlementService } from './historical-settlement.service.ts';
import { SettlementService } from './settlement.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

describe('historical settlement', () => {
  it('keeps included past payments outside cash, preserves later receipts and replays once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc-s08-'));
    try {
      await withRollback(async (db) => {
        const [user] = await db
          .insert(userProfiles)
          .values({
            email: `historical-${crypto.randomUUID()}@test.local`,
            name: 'T',
            passwordHash: 'h',
          })
          .returning();
        const [wallet, expense, revenue] = await db
          .insert(accounts)
          .values([
            {
              userId: user.id,
              name: 'Wallet',
              type: 'checking',
              openingBalance: '1000.00',
              openingBalanceAnchorAt: new Date('2026-09-15T12:00:00Z'),
            },
            { userId: user.id, name: 'Expense', type: 'expense' },
            { userId: user.id, name: 'Revenue', type: 'revenue' },
          ])
          .returning();
        const [old, after] = await db
          .insert(transactions)
          .values([
            {
              userId: user.id,
              sourceAccountId: wallet.id,
              destinationAccountId: expense.id,
              type: 'withdrawal',
              domainType: 'recurring_bill',
              amount: '100.00',
              description: 'Old charge',
              date: new Date('2026-09-10'),
            },
            {
              userId: user.id,
              sourceAccountId: wallet.id,
              destinationAccountId: expense.id,
              type: 'withdrawal',
              domainType: 'recurring_bill',
              amount: '30.00',
              description: 'New charge',
              date: new Date('2026-09-20'),
            },
            {
              userId: user.id,
              sourceAccountId: revenue.id,
              destinationAccountId: wallet.id,
              type: 'deposit',
              domainType: 'income_rental',
              amount: '50.00',
              description: 'Receipt',
              date: new Date('2026-09-18'),
              isPaid: true,
              paidAt: new Date('2026-09-18T12:00:00Z'),
              settlementDate: new Date('2026-09-18T12:00:00Z'),
              settlementSource: 'manual',
              cashAmount: '50.00',
            },
          ])
          .returning();
        const service = new HistoricalSettlementService(db);
        const target = 'b'.repeat(64);
        const manifest = await service.preview(
          {
            userId: user.id,
            walletId: wallet.id,
            entries: [
              {
                transactionId: old.id,
                amount: '100.00',
                settlementDate: '2026-09-10T12:00:00Z',
                source: 'manual',
                evidence: 'Included in observed bank balance',
              },
            ],
          },
          target,
        );
        const file = join(dir, 'receipt.dump');
        const bytes = 'external backup boundary fixture';
        await writeFile(file, bytes);
        const safety = {
          target,
          confirmTarget: target,
          expectedHash: manifest.hash,
          producersPaused: true,
          backup: {
            version: 1 as const,
            target,
            file,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            createdAt: new Date().toISOString(),
          },
        };
        await expect(
          service.apply(manifest, { ...safety, confirmTarget: 'c'.repeat(64) }),
        ).rejects.toThrow('HISTORICAL_REVIEW_REQUIRED');
        await expect(service.apply({ ...manifest, cashBefore: '9999.00' }, safety)).rejects.toThrow(
          'HISTORICAL_REVIEW_REQUIRED',
        );
        await expect(
          service.preview({ ...manifest.request, userId: crypto.randomUUID() }, target),
        ).rejects.toThrow('HISTORICAL_WALLET_REQUIRED');
        await expect(
          service.preview(
            {
              ...manifest.request,
              entries: [{ ...manifest.request.entries[0], settlementDate: '2026-09-16T12:00:00Z' }],
            },
            target,
          ),
        ).rejects.toThrow('HISTORICAL_ENTRY_NOT_ELIGIBLE');
        expect(await service.apply(manifest, safety)).toMatchObject({
          cashBefore: '1050.00',
          cashAfter: '1050.00',
          replayed: false,
        });
        expect(await service.apply(manifest, safety)).toMatchObject({ replayed: true });
        const inverse = await service.previewInverse(manifest);
        const reverseSafety = {
          ...safety,
          expectedHash: inverse.hash,
          backup: { ...safety.backup, createdAt: new Date().toISOString() },
        };
        expect(await service.revert(inverse, reverseSafety)).toMatchObject({ replayed: false });
        expect(await service.revert(inverse, reverseSafety)).toMatchObject({ replayed: true });
        expect((await new WalletCashService(db).getWalletCash(user.id)).totalCash).toBe(1050);
        const fresh = await service.preview(manifest.request, target);
        await service.apply(fresh, {
          ...safety,
          expectedHash: fresh.hash,
          backup: { ...safety.backup, createdAt: new Date().toISOString() },
        });
        await new SettlementService(db).settle(user.id, {
          transactionId: after.id,
          walletAccountId: wallet.id,
          leg: 'source',
          settlementDate: new Date('2026-09-20T12:00:00Z'),
        });
        expect((await new WalletCashService(db).getWalletCash(user.id)).totalCash).toBe(1020);
        await expect(
          db.transaction((tx) => new SettlementService(tx).unsettle(user.id, old.id)),
        ).rejects.toThrow('reviewed repair');
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
