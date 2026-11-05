import { expect, it } from 'vitest';
import { createTestUser } from '../../test/create-test-user.ts';
import { withRollback } from '../../test/with-rollback.ts';
import { AccountService } from '../account.service.ts';
import { CreditCardFlowService } from '../credit-card-flow.service.ts';
import { getCreditCardSpending } from './credit-cards.ts';

it('nets refunds while retaining direction and excluding recurring bill expenses', async () => {
  await withRollback(async (db) => {
    const user = await createTestUser(db);
    const expense = await new AccountService(db).create(user.id, {
      name: 'Expense',
      type: 'expense',
      currency: 'BRL',
    });
    const flow = new CreditCardFlowService(db);
    const { account: card } = await flow.createCreditCard(user.id, {
      name: 'Card',
      closingDay: 24,
      dueDay: 8,
    });
    const input = {
      creditCardAccountId: card.id,
      expenseAccountId: expense.id,
      billingMonth: 8,
      billingYear: 2026,
    };
    await flow.addOneTimeExpense(user.id, { ...input, description: 'Purchase', amount: '100.00' });
    await flow.addRefund(user.id, { ...input, description: 'Refund', amount: '20.00' });
    await flow.addFixedCharge(user.id, {
      creditCardAccountId: card.id,
      expenseAccountId: expense.id,
      description: 'Subscription',
      amount: '30.00',
      startDate: new Date(2026, 7, 1),
      dueDay: 8,
      firstBillingMonth: 8,
      firstBillingYear: 2026,
    });
    const [result] = await getCreditCardSpending(db, user.id, 8, 2026);
    expect(result?.total).toBe('80.00');
    expect(result?.items).toHaveLength(2);
    expect(result?.items).toContainEqual(
      expect.objectContaining({
        amount: '-20.00',
        direction: 'in',
        domainType: 'credit_card_refund',
      }),
    );
  });
});
