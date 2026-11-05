import { accounts, transactions } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { financialRevision } from '../lib/financial-revision.ts';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { LoanFlowService } from './loan-flow.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

describe('exact loan occurrence settlement', () => {
  it('settles the displayed installment once without paying the oldest unpaid installment', () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [wallet, loan] = await db
        .insert(accounts)
        .values([
          {
            userId: user.id,
            name: 'Bank',
            type: 'checking',
            openingBalance: '1000.00',
            openingBalanceAnchorAt: new Date('2026-01-01T12:00:00Z'),
          },
          { userId: user.id, name: 'Loan', type: 'loan' },
        ])
        .returning();
      const [old, displayed] = await db
        .insert(transactions)
        .values(
          [8, 9].map((month) => ({
            userId: user.id,
            sourceAccountId: wallet.id,
            destinationAccountId: loan.id,
            domainType: 'loan_payment' as const,
            type: 'transfer' as const,
            amount: '100.00',
            description: 'Installment',
            date: new Date(Date.UTC(2026, month - 1, 10)),
          })),
        )
        .returning();
      const input = {
        accountId: loan.id,
        transactionId: displayed.id,
        paidFromAccountId: wallet.id,
        settlementDate: new Date('2026-09-12T12:00:00Z'),
        expectedRevision: financialRevision(displayed),
      };
      const service = new LoanFlowService(db);
      await expect(
        db.transaction((tx) =>
          new LoanFlowService(tx).markOccurrenceAsPaid(crypto.randomUUID(), input),
        ),
      ).rejects.toThrow();
      await service.markOccurrenceAsPaid(user.id, input);
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, old.id)))[0].isPaid,
      ).toBe(false);
      expect((await new WalletCashService(db).getWalletCash(user.id)).totalCash).toBe(900);
      await expect(
        db.transaction((tx) => new LoanFlowService(tx).markOccurrenceAsPaid(user.id, input)),
      ).rejects.toThrow('Occurrence changed');
      expect((await new WalletCashService(db).getWalletCash(user.id)).totalCash).toBe(900);
    }));
});
