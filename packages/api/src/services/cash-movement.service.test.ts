import { accounts, transactions } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { CashMovementService } from './cash-movement.service.ts';

describe('CashMovementService', () => {
  it('paginates actual cash, includes transfer payments once and keeps totals independent from page', () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [wallet, other, card, expense, revenue] = await db
        .insert(accounts)
        .values([
          { userId: user.id, name: 'Bank', type: 'checking' },
          { userId: user.id, name: 'Other bank', type: 'checking' },
          { userId: user.id, name: 'Card', type: 'credit_card' },
          { userId: user.id, name: 'Expense', type: 'expense' },
          { userId: user.id, name: 'Revenue', type: 'revenue' },
        ])
        .returning();
      const base = {
        userId: user.id,
        date: new Date('2026-08-10'),
        settlementDate: new Date('2026-09-12T12:00:00Z'),
        paidAt: new Date('2026-09-13T12:00:00Z'),
        isPaid: true,
        settlementSource: 'manual' as const,
        amount: '100.00',
        cashAmount: '100.00',
        description: 'Cash',
      };
      await db.insert(transactions).values([
        {
          ...base,
          sourceAccountId: wallet.id,
          destinationAccountId: card.id,
          type: 'transfer',
          domainType: 'bill_payment',
        },
        { ...base, sourceAccountId: wallet.id, destinationAccountId: other.id, type: 'transfer' },
        {
          ...base,
          sourceAccountId: revenue.id,
          destinationAccountId: wallet.id,
          type: 'deposit',
          domainType: 'income_rental',
          amount: '500.00',
          cashAmount: '500.00',
        },
        {
          ...base,
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          type: 'withdrawal',
          domainType: 'credit_card_expense',
          billingMonth: 9,
          billingYear: 2026,
        },
        {
          ...base,
          sourceAccountId: wallet.id,
          destinationAccountId: expense.id,
          type: 'withdrawal',
          domainType: 'recurring_bill',
          settlementSource: 'legacy',
        },
      ]);
      const service = new CashMovementService(db);
      const result = await service.list(user.id, { month: 9, year: 2026, page: 1, pageSize: 2 });
      expect(result).toMatchObject({
        total: 4,
        incoming: '500.00',
        outgoing: '100.00',
        unconfirmedCount: 1,
      });
      expect(result.items).toHaveLength(2);
      expect(
        await service.list(user.id, { month: 9, year: 2026, page: 2, pageSize: 2 }),
      ).toMatchObject({ total: 4, incoming: '500.00', outgoing: '100.00' });
      expect(
        await service.list(user.id, {
          month: 9,
          year: 2026,
          page: 1,
          pageSize: 40,
          accountId: wallet.id,
        }),
      ).toMatchObject({ outgoing: '200.00' });
      expect(
        await service.list(crypto.randomUUID(), { month: 9, year: 2026, page: 1, pageSize: 2 }),
      ).toMatchObject({ total: 0 });
    }));
});
