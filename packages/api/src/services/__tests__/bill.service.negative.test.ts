import type { DbExecutor } from '@fc/db';
import { transactions, userProfiles } from '@fc/db';
import { BusinessRuleError, InvariantViolationError } from '@fc/domain';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../../test/with-rollback.ts';
import { AccountService } from '../account.service.ts';
import { BillService } from '../bill.service.ts';
import { CreditCardFlowService } from '../credit-card-flow.service.ts';
import { MaterializationGuard } from '../materialization-guard.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const ccFlow = new CreditCardFlowService(db);
  const billService = new BillService(db, new MaterializationGuard(db));

  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'bill-neg@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();
  const userId = user.id;

  const checking = await accountService.create(userId, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  const expense = await accountService.create(userId, {
    name: 'Food',
    type: 'expense',
    currency: 'BRL',
  });

  return {
    accountService,
    ccFlow,
    billService,
    userId,
    checkingId: checking.id,
    expenseId: expense.id,
  };
}

describe('BillService.payBill — invariants', () => {
  it('throws BusinessRuleError when unpaidTotal is zero (already fully paid)', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      await ccFlow.addInstallment(userId, {
        creditCardAccountId: account.id,
        expenseAccountId: expenseId,
        description: 'TV',
        amount: '500.00',
        totalInstallments: 1,
        currentInstallmentNumber: 1,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      });

      await billService.payBill(userId, account.id, 4, 2026, checkingId);

      // Second attempt: unpaidTotal == 0 → BusinessRuleError (predictable, user-facing).
      await expect(
        billService.payBill(userId, account.id, 4, 2026, checkingId),
      ).rejects.toBeInstanceOf(BusinessRuleError);
      await expect(billService.payBill(userId, account.id, 4, 2026, checkingId)).rejects.toThrow(
        'Não há valor pendente nesta fatura',
      );
    });
  });

  it('throws BusinessRuleError when bill is empty (no transactions at all)', async () => {
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });
      await expect(
        billService.payBill(userId, account.id, 4, 2026, checkingId),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });
  });

  it('throws InvariantViolationError when unpaidTotal is negative (data corruption)', async () => {
    // DDL inside withRollback: ALTER TABLE ... DROP CONSTRAINT inside a
    // transaction is fully transactional in PostgreSQL — the rollback undoes
    // it along with the corrupt data seeding.
    await withRollback(async (db) => {
      const { ccFlow, billService, userId, checkingId, expenseId } = await seed(db);
      const { account } = await ccFlow.createCreditCard(userId, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });

      await db.execute(sql`ALTER TABLE transactions DROP CONSTRAINT IF EXISTS tx_amount_positive`);

      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '-500.00',
          description: 'corrupt-negative',
          type: 'withdrawal',
          domainType: 'credit_card_expense',
          date: new Date(2026, 3, 15),
          billingMonth: 4,
          billingYear: 2026,
          isPaid: false,
          isReversed: false,
          currency: 'BRL',
        },
        {
          userId,
          sourceAccountId: expenseId,
          destinationAccountId: account.id,
          amount: '500.00',
          description: 'corrupt-positive-paid',
          type: 'withdrawal',
          domainType: 'credit_card_expense',
          date: new Date(2026, 3, 15),
          billingMonth: 4,
          billingYear: 2026,
          isPaid: true,
          paidAt: new Date(),
          isReversed: false,
          currency: 'BRL',
        },
      ]);

      await expect(
        billService.payBill(userId, account.id, 4, 2026, checkingId),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });
  });
});
