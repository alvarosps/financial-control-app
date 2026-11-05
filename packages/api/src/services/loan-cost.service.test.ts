import { accounts, loanConfigs, transactions } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { LoanFlowService } from './loan-flow.service.ts';

describe('loan cost evidence', () => {
  it('keeps the last unpaid installment, zero-rate estimate and valid quote distinct; flags insufficient or unreviewed cash', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const wallet = await new AccountService(db).create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const flow = new LoanFlowService(db);
      const { account } = await flow.createLoan(user.id, {
        name: 'Last payment',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '100.00',
        totalInstallments: 1,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date('2026-09-10'),
        checkingAccountId: wallet.id,
        monthlyInterestRate: '0.00000000',
        paymentMethod: 'bank_debit',
      });
      const before = await flow.getPayoffInfo(
        user.id,
        account.id,
        new Date('2026-09-28T15:00:00Z'),
      );
      expect(before).toMatchObject({
        remainingInstallments: 1,
        outstandingBalance: '100.00',
        totalIfPaying: '100.00',
        annualCet: null,
        payoffQuote: { status: 'missing' },
        cashReady: false,
      });
      await flow.updateCostEvidence(user.id, account.id, {
        annualCet: { rate: '0.42000000', source: 'Contract', observedOn: '2026-09-20' },
        payoffQuote: {
          amount: '90.00',
          quotedOn: '2026-09-20',
          validUntil: '2026-09-30',
          source: 'Bank quote',
        },
        economicResponsibility: 'family',
      });
      await db
        .update(accounts)
        .set({
          openingBalance: '50.00',
          cashAnchorBasis: 'effective',
          openingBalanceAnchorAt: new Date('2026-09-28T12:00:00Z'),
        })
        .where(eq(accounts.id, wallet.id));
      const after = await flow.getPayoffInfo(user.id, account.id, new Date('2026-09-28T15:00:00Z'));
      expect(after).toMatchObject({
        outstandingBalance: '100.00',
        annualCet: { rate: '0.42000000', source: 'Contract' },
        payoffQuote: { status: 'valid', selectedAmount: '90.00' },
        monthlyRelease: '100.00',
        economicResponsibility: 'family',
        cashReady: true,
        exceedsAvailableCash: true,
      });
      expect(
        (await flow.getPayoffInfo(user.id, account.id, new Date('2026-10-01T15:00:00Z')))
          .payoffQuote.status,
      ).toBe('expired');
      expect(
        (await db.select().from(loanConfigs).where(eq(loanConfigs.accountId, account.id)))[0]
          .monthlyInterestRate,
      ).toBe('0.00000000');
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, user.id)),
      ).toHaveLength(1);
      const [due] = await db.select().from(transactions).where(eq(transactions.userId, user.id));
      await flow.markOccurrenceAsPaid(user.id, {
        accountId: account.id,
        transactionId: due.id,
        paidFromAccountId: wallet.id,
        settlementDate: new Date('2026-09-28T14:00:00Z'),
      });
      expect(
        await flow.getPayoffInfo(user.id, account.id, new Date('2026-09-28T15:00:00Z')),
      ).toMatchObject({
        remainingInstallments: 0,
        outstandingBalance: '0.00',
        monthlyRelease: '0.00',
        payoffQuote: { selectedAmount: '0.00', status: 'missing' },
      });
    }));
  it('requires complete evidence tuples and ownership while permitting explicit removal', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db),
        other = await createTestUser(db);
      const [loan] = await db
        .insert(accounts)
        .values({ userId: user.id, name: 'Loan', type: 'loan' })
        .returning();
      await db.insert(loanConfigs).values({
        accountId: loan.id,
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '100.00',
        totalInstallments: 1,
        dueDay: 10,
        monthlyInterestRate: '0.01000000',
      });
      const flow = new LoanFlowService(db);
      await expect(
        flow.updateCostEvidence(other.id, loan.id, { economicResponsibility: 'own' }),
      ).rejects.toThrow();
      await expect(
        flow.updateCostEvidence(user.id, loan.id, {
          payoffQuote: {
            amount: '90.00',
            quotedOn: '2026-09-30',
            validUntil: '2026-09-20',
            source: 'Bank',
          },
        }),
      ).rejects.toThrow();
      await flow.updateCostEvidence(user.id, loan.id, {
        annualCet: null,
        payoffQuote: null,
        economicResponsibility: 'unknown',
      });
      expect((await flow.getPayoffInfo(user.id, loan.id)).annualCet).toBeNull();
    }));
});
