import type { DbExecutor } from '@fc/db';
import { accounts } from '@fc/db';
import type { IngestFinancialEventInput } from '../lib/purchase-input.ts';
import { CreditCardFlowService } from '../services/credit-card-flow.service.ts';
import { createTestUser } from './create-test-user.ts';

export async function purchaseFixture(db: DbExecutor) {
  const user = await createTestUser(db);
  const [expense] = await db
    .insert(accounts)
    .values({ userId: user.id, name: 'Expense', type: 'expense' })
    .returning();
  const { account: card } = await new CreditCardFlowService(db).createCreditCard(user.id, {
    name: 'Card',
    closingDay: 24,
    dueDay: 8,
  });
  const data: IngestFinancialEventInput['data'] = {
    cardAccountId: card.id,
    description: 'Laptop',
    amount: '100.00',
    currency: 'BRL',
    amountMeaning: 'installment',
    kind: 'purchase',
    purchaseDate: '2026-09-20',
    postedDate: null,
    installmentNumber: 1,
    totalInstallments: 3,
    confirmation: 'observed',
  };
  const event = {
    source: 'manual' as const,
    sourceScope: 'local',
    externalId: 'purchase-1',
    sourceVersion: 1,
    parserVersion: 'manual-1',
    observedAt: new Date('2026-09-20T15:00:00Z'),
    data,
  };
  return { user, card, expense, event };
}
