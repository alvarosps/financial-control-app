import type { DbExecutor } from '@fc/db';
import { accounts, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { FamilyLoanPaymentService } from './family-loan-payment.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const flowService = new FamilyLoanFlowService(db);
  const paymentService = new FamilyLoanPaymentService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'family-loan-payment@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();

  const wallet = await accountService.create(user.id, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  await db
    .update(accounts)
    .set({ openingBalanceAnchorAt: new Date('2026-01-01T00:00:00Z') })
    .where(eq(accounts.id, wallet.id));
  const { config } = await flowService.createFamilyLoan(user.id, { personName: 'Célia' });

  return { accountService, flowService, paymentService, userId: user.id, wallet, config };
}

describe('FamilyLoanPaymentService', () => {
  it('requires a reviewed repair for a receipt before the reconciled wallet anchor', async () => {
    await withRollback(async (db) => {
      const { paymentService, userId, wallet, config } = await seed(db);
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2026-06-10T15:00:00Z') })
        .where(eq(accounts.id, wallet.id));
      await expect(
        paymentService.recordPayment(userId, {
          configId: config.id,
          amount: '2000.00',
          date: new Date('2026-06-05T15:00:00Z'),
          walletAccountId: wallet.id,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  it('recordPayment creates a paid deposit into the wallet that counts as real cash', async () => {
    await withRollback(async (db) => {
      const { paymentService, userId, wallet, config } = await seed(db);
      const payment = await paymentService.recordPayment(userId, {
        configId: config.id,
        amount: '2000.00',
        date: new Date(2026, 5, 5),
        walletAccountId: wallet.id,
      });
      expect(payment.domainType).toBe('family_loan_payment');
      expect(payment.type).toBe('deposit');
      expect(payment.isPaid).toBe(true);
      expect(payment.cashAmount).toBe('2000.00');
      expect(payment.settlementSource).toBe('manual');
      expect(payment.settlementDate).toEqual(new Date('2026-06-05T00:00:00-03:00'));
      expect(payment.destinationAccountId).toBe(wallet.id);
      const { WalletCashService } = await import('./wallet-cash.service.ts');
      const cash = await new WalletCashService(db).getWalletCash(userId, new Date(2026, 5, 6));
      expect(cash.totalCash).toBeGreaterThanOrEqual(2000);
    });
  });

  it('recordPayment rejects a non-checking wallet', async () => {
    await withRollback(async (db) => {
      const { accountService, paymentService, userId, config } = await seed(db);
      const savings = await accountService.create(userId, {
        name: 'Poup',
        type: 'savings',
        currency: 'BRL',
      });
      await expect(
        paymentService.recordPayment(userId, {
          configId: config.id,
          amount: '100.00',
          date: new Date(2026, 5, 5),
          walletAccountId: savings.id,
        }),
      ).rejects.toThrow();
    });
  });

  it('listPayments returns payments and reversePayment removes them from cash', async () => {
    await withRollback(async (db) => {
      const { paymentService, userId, wallet, config } = await seed(db);
      const payment = await paymentService.recordPayment(userId, {
        configId: config.id,
        amount: '2000.00',
        date: new Date(2026, 5, 5),
        walletAccountId: wallet.id,
      });
      let list = await paymentService.listPayments(userId, config.id);
      expect(list).toHaveLength(1);
      await paymentService.reversePayment(userId, payment.id);
      list = await paymentService.listPayments(userId, config.id);
      expect(list).toHaveLength(0);
    });
  });

  it('reversePayment rejects a non-payment transaction', async () => {
    await withRollback(async (db) => {
      const { flowService, paymentService, userId, config } = await seed(db);
      const charge = await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'C',
        amount: '50.00',
        date: new Date(2026, 5, 1),
      });
      const [transaction] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, charge.schedule.id));
      await expect(paymentService.reversePayment(userId, transaction.id)).rejects.toThrow();
    });
  });
});
