import { accounts, creditCardConfigs, transactions, userProfiles } from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { noOpGuard } from '../lib/materialization-guard.ts';
import { withRollback } from '../test/with-rollback.ts';
import { FinancialObligationsService } from './financial-obligations.service.ts';

describe('FinancialObligationsService', () => {
  it('counts obligations instead of internal card rows and isolates users', () =>
    withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({
          email: `obligations-${crypto.randomUUID()}@test.local`,
          name: 'T',
          passwordHash: 'h',
        })
        .returning();
      const created = await db
        .insert(accounts)
        .values([
          { userId: user.id, name: 'Wallet', type: 'checking' as const },
          { userId: user.id, name: 'Expense', type: 'expense' as const },
          { userId: user.id, name: 'Card', type: 'credit_card' as const },
          { userId: user.id, name: 'Income', type: 'revenue' as const },
        ])
        .returning();
      const [wallet, expense, card, income] = created;
      await db.insert(creditCardConfigs).values({ accountId: card.id, closingDay: 20, dueDay: 5 });
      const base = { userId: user.id, currency: 'BRL', date: new Date('2026-09-10T00:00:00Z') };
      await db.insert(transactions).values([
        {
          ...base,
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          amount: '200.00',
          type: 'withdrawal',
          description: 'Card purchase',
          domainType: 'credit_card_expense',
          billingMonth: 8,
          billingYear: 2026,
          isPaid: true,
        },
        {
          ...base,
          sourceAccountId: wallet.id,
          destinationAccountId: card.id,
          amount: '200.00',
          type: 'transfer',
          description: 'Legacy bill payment',
          domainType: 'bill_payment',
          billingMonth: 8,
          billingYear: 2026,
        },
        {
          ...base,
          sourceAccountId: wallet.id,
          destinationAccountId: expense.id,
          amount: '50.00',
          type: 'withdrawal',
          description: 'Charge',
          domainType: 'recurring_bill',
        },
        {
          ...base,
          sourceAccountId: income.id,
          destinationAccountId: wallet.id,
          amount: '300.00',
          type: 'deposit',
          description: 'Income',
          domainType: 'income_rental',
        },
        {
          ...base,
          sourceAccountId: card.id,
          destinationAccountId: expense.id,
          amount: '15.00',
          type: 'withdrawal',
          description: 'Unknown card movement',
        },
      ]);
      const service = new FinancialObligationsService(db, noOpGuard);
      const result = await service.listForDuePeriod(user.id, 9, 2026);
      expect(result.items.filter((x) => x.ref.kind === 'card_bill')).toHaveLength(1);
      expect(result.summary.payableCount).toBe(1);
      expect(result.summary.receivableCount).toBe(1);
      expect(result.summary.toPay).toBe('50.00');
      expect(result.reviewIssues.map((x) => x.reason)).toEqual(
        expect.arrayContaining(['legacy_bill_payment', 'unclassified_card_movement']),
      );
      await db
        .update(transactions)
        .set({
          isPaid: true,
          settlementDate: new Date('2026-09-12T12:00:00Z'),
          paidAt: new Date('2026-09-13T12:00:00Z'),
          settlementSource: 'bank',
          cashAmount: '200.00',
        })
        .where(and(eq(transactions.userId, user.id), eq(transactions.domainType, 'bill_payment')));
      const confirmed = await service.listForDuePeriod(user.id, 9, 2026);
      expect(confirmed.items.find((i) => i.ref.kind === 'card_bill')).toMatchObject({
        confirmedCash: '200.00',
        evidence: 'bank',
      });
      expect(confirmed.reviewIssues.filter((i) => i.reason === 'legacy_bill_payment')).toHaveLength(
        0,
      );
      await db.insert(transactions).values({
        ...base,
        sourceAccountId: expense.id,
        destinationAccountId: card.id,
        amount: '10.00',
        currency: 'USD',
        type: 'withdrawal',
        description: 'Unconverted foreign purchase',
        domainType: 'credit_card_expense',
        billingMonth: 8,
        billingYear: 2026,
      });
      const foreign = await service.listForDuePeriod(user.id, 9, 2026);
      expect(foreign.items.filter((i) => i.ref.kind === 'card_bill')).toHaveLength(0);
      expect(foreign.summary.toPay).toBe('50.00');
      expect(foreign.reviewIssues.some((i) => i.reason === 'missing_amount')).toBe(true);
      const other = await service.listForDuePeriod(crypto.randomUUID(), 9, 2026);
      expect(other.items).toEqual([]);
      expect(other.reviewIssues).toEqual([]);
    }));
});
