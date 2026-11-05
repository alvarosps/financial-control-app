import type { DbExecutor } from '@fc/db';
import {
  accounts,
  creditCardBills,
  creditCardConfigs,
  incomeSourceConfigs,
  transactions,
  userProfiles,
} from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { DailyControlService } from './daily-control.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';

async function seed(db: DbExecutor, email = 'daily@test.com') {
  const [user] = await db
    .insert(userProfiles)
    .values({ email, name: 'T', passwordHash: 'h' })
    .returning();
  const accountService = new AccountService(db);
  const checking = await accountService.create(user.id, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  const card = await accountService.create(user.id, {
    name: 'Card',
    type: 'credit_card',
    currency: 'BRL',
  });
  const revenue = await accountService.create(user.id, {
    name: 'Salary',
    type: 'revenue',
    currency: 'BRL',
  });
  const expense = await accountService.create(user.id, {
    name: 'Expense',
    type: 'expense',
    currency: 'BRL',
  });
  const familyLoan = await accountService.create(user.id, {
    name: 'Family',
    type: 'family_loan',
    currency: 'BRL',
  });
  await db.insert(creditCardConfigs).values({ accountId: card.id, closingDay: 1, dueDay: 10 });
  return {
    userId: user.id,
    checkingId: checking.id,
    cardId: card.id,
    revenueId: revenue.id,
    expenseId: expense.id,
    familyLoanId: familyLoan.id,
    service: new DailyControlService(db),
  };
}

describe('DailyControlService.getDailyControl (aggregated)', () => {
  it('folds an additional (child) card into the principal — never a separate card item', async () => {
    await withRollback(async (db) => {
      const s = await seed(db);
      const accountService = new AccountService(db);
      const child = await accountService.create(s.userId, {
        name: 'Card - Additional',
        type: 'credit_card',
        currency: 'BRL',
        parentAccountId: s.cardId,
      });
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.expenseId,
          destinationAccountId: s.cardId,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'principal charge',
          date: new Date(2026, 5, 3),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        },
        {
          userId: s.userId,
          sourceAccountId: s.expenseId,
          destinationAccountId: child.id,
          amount: '50.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'child charge',
          date: new Date(2026, 5, 4),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const cardItems = result.days.flatMap((d) => d.items).filter((i) => i.kind === 'card');

      // Exactly one card item (the principal); the child is folded into it and
      // is never listed as its own row in the daily control.
      expect(cardItems).toHaveLength(1);
      expect(cardItems[0].id).toBe(s.cardId);
      expect(cardItems[0].amount).toBe(150);
      expect(cardItems.some((i) => i.id === child.id)).toBe(false);
    });
  });

  it('shows one card item per fatura (not installments) and includes income', async () => {
    await withRollback(async (db) => {
      const s = await seed(db);
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.cardId,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'P1',
          date: new Date(2026, 5, 3),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          installmentNumber: 1,
          totalInstallments: 3,
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.cardId,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'P2',
          date: new Date(2026, 5, 4),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          installmentNumber: 1,
          totalInstallments: 3,
        },
        {
          userId: s.userId,
          sourceAccountId: s.revenueId,
          destinationAccountId: s.checkingId,
          amount: '5000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário',
          date: new Date(2026, 5, 5),
          domainType: 'income_clt',
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const allItems = result.days.flatMap((d) => d.items);
      const cardItems = allItems.filter((i) => i.kind === 'card');
      expect(cardItems.length).toBe(1);
      expect(cardItems[0].amount).toBe(200); // whole fatura on dueDay
      expect(cardItems[0].date).toBe('2026-06-10'); // emitted on the dueDay
      expect(cardItems[0].direction).toBe('out');
      expect(allItems.some((i) => i.kind === 'income')).toBe(true);
      expect(allItems.every((i) => !('installmentNumber' in i))).toBe(true);

      const income = allItems.find((i) => i.kind === 'income');
      expect(income?.direction).toBe('in');
      expect(income?.amount).toBe(5000);

      expect(result.summary.totalItems).toBe(2);
      expect(result.summary.totalIn).toBe(5000);
      expect(result.summary.totalOut).toBe(200);
      expect(result.summary.balance).toBe(4800);
    });
  });

  it('excludes reversal rows from totals and produces no phantom item', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-reversal@test.com');
      // Original expense, then its reversal row (mirrors TransactionService.reverse):
      // original is flagged isReversed=true; the reversal row swaps accounts,
      // keeps the same type, has reversesTransactionId set, isReversed=false,
      // and a NULL domainType.
      const [original] = await db
        .insert(transactions)
        .values({
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '300.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Groceries',
          date: new Date(2026, 5, 7),
          isReversed: true,
          domainType: 'recurring_bill',
          totalInstallments: 1,
        })
        .returning();
      await db.insert(transactions).values({
        userId: s.userId,
        sourceAccountId: s.expenseId,
        destinationAccountId: s.checkingId,
        amount: '300.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: '[Reversal] Groceries',
        date: new Date(2026, 5, 7),
        isReversed: false,
        reversesTransactionId: original.id,
        domainType: null,
      });

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const allItems = result.days.flatMap((d) => d.items);
      expect(allItems.length).toBe(0);
      expect(result.summary.totalOut).toBe(0);
      expect(result.summary.balance).toBe(0);
    });
  });

  it('nets a credit_card_refund against the fatura', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-refund@test.com');
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.cardId,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Spend',
          date: new Date(2026, 5, 3),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        },
        {
          // Refunds credit the card: destination = card (mirrors BillService).
          userId: s.userId,
          sourceAccountId: s.revenueId,
          destinationAccountId: s.cardId,
          amount: '50.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Refund',
          date: new Date(2026, 5, 4),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_refund',
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const cardItems = result.days.flatMap((d) => d.items).filter((i) => i.kind === 'card');
      expect(cardItems.length).toBe(1);
      expect(cardItems[0].amount).toBe(150);
    });
  });

  it('ignores bill_payment rows when computing the fatura total', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-billpay@test.com');
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.cardId,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Spend',
          date: new Date(2026, 5, 3),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.cardId,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Fatura payment',
          date: new Date(2026, 5, 9),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'bill_payment',
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const cardItems = result.days.flatMap((d) => d.items).filter((i) => i.kind === 'card');
      expect(cardItems.length).toBe(1);
      expect(cardItems[0].amount).toBe(200);
    });
  });

  it('suppresses the card item only when refunds EXACTLY cancel the spend (zero net)', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-zero@test.com');
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.cardId,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Spend',
          date: new Date(2026, 5, 3),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        },
        {
          // Refunds credit the card: destination = card (mirrors BillService).
          userId: s.userId,
          sourceAccountId: s.revenueId,
          destinationAccountId: s.cardId,
          amount: '100.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Refund',
          date: new Date(2026, 5, 4),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_refund',
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const cardItems = result.days.flatMap((d) => d.items).filter((i) => i.kind === 'card');
      expect(cardItems.length).toBe(0);
    });
  });

  // H7: a card whose refunds EXCEED its charges has a negative net — that is a
  // legitimate credit balance and must be surfaced as an inflow (MonthSummary
  // counts it), not dropped.
  it('surfaces a net-negative card (refunds > charges) as a credit inflow', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-credit@test.com');
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.cardId,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Spend',
          date: new Date(2026, 5, 3),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        },
        {
          userId: s.userId,
          sourceAccountId: s.revenueId,
          destinationAccountId: s.cardId,
          amount: '120.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Refund',
          date: new Date(2026, 5, 4),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_refund',
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const cardItems = result.days.flatMap((d) => d.items).filter((i) => i.kind === 'card');
      expect(cardItems.length).toBe(1);
      expect(cardItems[0].direction).toBe('in');
      expect(cardItems[0].amount).toBe(20);
      expect(result.summary.totalIn).toBe(20);
      expect(result.summary.totalOut).toBe(0);
    });
  });

  // H8: an additional/child card folds into its parent — ONE consolidated card
  // item, total = parent + child net of refunds, dueDay/name from the parent.
  it('consolidates a child (additional) card into its parent (one item, summed net)', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-child@test.com');
      const accountService = new AccountService(db);
      const child = await accountService.create(s.userId, {
        name: 'Card Adicional',
        type: 'credit_card',
        currency: 'BRL',
        parentAccountId: s.cardId,
      });
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.cardId,
          amount: '300.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parent spend',
          date: new Date(2026, 5, 3),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: child.id,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Child spend',
          date: new Date(2026, 5, 4),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_expense',
        },
        {
          // Refund on the child card nets against the consolidated total.
          userId: s.userId,
          sourceAccountId: s.revenueId,
          destinationAccountId: child.id,
          amount: '50.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Child refund',
          date: new Date(2026, 5, 5),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_refund',
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const cardItems = result.days.flatMap((d) => d.items).filter((i) => i.kind === 'card');
      expect(cardItems.length).toBe(1); // child does NOT appear as its own item
      expect(cardItems[0].id).toBe(s.cardId); // emitted under the parent
      expect(cardItems[0].name).toBe('Card'); // parent's name
      expect(cardItems[0].amount).toBe(450); // 300 + 200 − 50
      expect(cardItems[0].date).toBe('2026-06-10'); // parent's dueDay
      expect(cardItems[0].direction).toBe('out');
    });
  });

  // R10b: paid-state now comes from the canonical bill roll-up
  // (BillService.getBillForMonth), which derives isPaid from the transactions'
  // own isPaid flags — exactly what BillService.payBill sets when it settles a
  // fatura (it marks every charge isPaid AND upserts credit_card_bills together).
  // Seeding both mirrors that real settlement.
  it('marks the card item paid from the canonical fatura roll-up', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-paid@test.com');
      await db.insert(transactions).values({
        userId: s.userId,
        sourceAccountId: s.checkingId,
        destinationAccountId: s.cardId,
        amount: '300.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Spend',
        date: new Date(2026, 5, 3),
        billingMonth: 6,
        billingYear: 2026,
        domainType: 'credit_card_expense',
        isPaid: true,
        paidAt: new Date(),
      });
      await db.insert(creditCardBills).values({
        creditCardAccountId: s.cardId,
        month: 6,
        year: 2026,
        status: 'paid',
        totalAmount: '300.00',
        paidAmount: '300.00',
        paidAt: new Date(),
      });

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const cardItems = result.days.flatMap((d) => d.items).filter((i) => i.kind === 'card');
      expect(cardItems.length).toBe(1);
      expect(cardItems[0].isPaid).toBe(true);
      expect(result.summary.paidCount).toBe(1);
    });
  });

  it('classifies non-card items by domain type and transaction direction', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-classify@test.com');
      const loan = await new AccountService(db).create(s.userId, {
        name: 'Personal loan',
        type: 'loan',
        currency: 'BRL',
      });
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: loan.id,
          amount: '500.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Loan payment',
          date: new Date(2026, 5, 2),
          domainType: 'loan_payment',
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: loan.id,
          amount: '20.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Loan insurance',
          date: new Date(2026, 5, 2),
          domainType: 'loan_insurance',
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '99.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'One-time charge',
          date: new Date(2026, 5, 3),
          domainType: 'recurring_bill',
          totalInstallments: 1,
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '50.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Fixed charge (null installments)',
          date: new Date(2026, 5, 3),
          domainType: 'recurring_bill',
          totalInstallments: null,
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '60.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Fixed charge (>1 installments)',
          date: new Date(2026, 5, 3),
          domainType: 'recurring_bill',
          totalInstallments: 6,
        },
        {
          userId: s.userId,
          sourceAccountId: s.familyLoanId,
          destinationAccountId: s.checkingId,
          amount: '300.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Family loan repayment',
          date: new Date(2026, 5, 4),
          domainType: 'family_loan_installment',
        },
        {
          // Family-loan discount (transfer checking -> family_loan). This is an
          // INTERNAL ledger adjustment (it reduces the loan's owed), NOT a personal
          // cash flow, so it must be EXCLUDED from the daily control entirely —
          // family loans surface only via buildFamilyLoanItems (real payments).
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.familyLoanId,
          amount: '80.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Family loan discount transfer',
          date: new Date(2026, 5, 4),
          domainType: 'family_loan_discount',
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '40.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Untyped manual',
          date: new Date(2026, 5, 5),
          domainType: null,
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const byName = new Map(result.days.flatMap((d) => d.items).map((i) => [i.name, i]));

      expect(byName.get('Loan payment')?.kind).toBe('loan');
      expect(byName.get('Loan insurance')?.kind).toBe('loan');
      expect(byName.get('One-time charge')?.kind).toBe('one_time_charge');
      expect(byName.get('Fixed charge (null installments)')?.kind).toBe('fixed_charge');
      expect(byName.get('Fixed charge (>1 installments)')?.kind).toBe('fixed_charge');

      // Family-loan INFLOW rows (the deposit) are no longer emitted 1:1 — they
      // are surfaced by buildFamilyLoanItems as a collapsed expected receipt.
      // This config has no family_loan_configs row, so nothing is collapsed and
      // the raw deposit simply does not appear in the day items.
      expect(byName.has('Family loan repayment')).toBe(false);

      // Family-loan discount rows (transfers) are internal ledger adjustments, not
      // personal cash — they are excluded from the daily control entirely.
      expect(byName.has('Family loan discount transfer')).toBe(false);

      const untyped = byName.get('Untyped manual');
      expect(untyped?.kind).toBe('other');
      expect(untyped?.direction).toBe('out');
    });
  });

  it('excludes a family_loan_discount transfer from the daily control (internal ledger, not cash)', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-family-discount@test.com');
      // Real production shape: a family-loan discount installment is stored as a
      // transfer checking -> family_loan. It is an INTERNAL ledger adjustment (it
      // reduces the loan's owed via owedByMonthRange), NOT a personal cash flow,
      // so it must never surface in the daily control. Paid status is irrelevant —
      // buildNonCardItems has no is_paid filter, so both paid and unpaid leak.
      await db.insert(transactions).values({
        userId: s.userId,
        sourceAccountId: s.checkingId,
        destinationAccountId: s.familyLoanId,
        amount: '1534.50',
        currency: 'BRL',
        type: 'transfer',
        description: 'Carro Camila',
        date: new Date(2026, 5, 30),
        domainType: 'family_loan_discount',
      });

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const names = result.days.flatMap((d) => d.items).map((i) => i.name);

      expect(names).not.toContain('Carro Camila');
      expect(result.summary.totalOut).toBe(0);
      expect(result.summary.balance).toBe(0);
    });
  });

  // Task 4.1: a family loan surfaces ONE collapsed expected-receipt line (the
  // month's still-open remaining) on the person's receiptDay, PLUS each real
  // payment on its own date — no double counting of the underlying charges.
  it('aggregates the family balance without inventing a receipt date; actual deposits belong to cash movements)', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-family-flow@test.com');
      const flow = new FamilyLoanFlowService(db);
      const { config } = await flow.createFamilyLoan(s.userId, {
        personName: 'Mom',
        receiptDay: 10,
      });

      // A one-time charge of 500 in the navigated month (June 2026).
      await flow.addOneTimeCharge(s.userId, {
        configId: config.id,
        description: 'Emprestimo',
        amount: '500.00',
        date: new Date(Date.UTC(2026, 5, 1)),
        billingMonth: 6,
        billingYear: 2026,
      });

      // A recorded payment of 200 on June 20 (needs a BRL checking wallet).
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
        .where(eq(accounts.id, s.checkingId));
      await flow.recordPayment(s.userId, {
        configId: config.id,
        amount: '200.00',
        date: new Date(Date.UTC(2026, 5, 20)),
        walletAccountId: s.checkingId,
      });

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const allItems = result.days.flatMap((d) => d.items);
      const familyItems = result.undatedItems.filter((i) => i.name === 'Mom');
      expect(familyItems).toHaveLength(1);
      expect(familyItems[0]).toMatchObject({
        kind: 'income',
        direction: 'in',
        isPaid: false,
        amount: 300,
        date: '',
        dateUncertain: true,
      });
      expect(familyItems[0].obligation).toMatchObject({
        total: '500.00',
        remaining: '300.00',
        settledAmount: '200.00',
      });
      // No raw family deposit (the underlying expense charge) leaked through.
      expect(allItems.some((i) => i.name === 'Emprestimo')).toBe(false);
    });
  });

  // Task 4.1 guard: the family-INFLOW exclusion must be NULL-safe — an UNtyped
  // deposit (domainType NULL) is NOT a family inflow and must still surface 1:1.
  it('keeps an untyped deposit (not a family inflow) despite the exclusion', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-untyped-deposit@test.com');
      await db.insert(transactions).values({
        userId: s.userId,
        sourceAccountId: s.revenueId,
        destinationAccountId: s.checkingId,
        amount: '123.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Untyped deposit',
        date: new Date(2026, 5, 6),
        domainType: null,
      });

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const allItems = result.days.flatMap((d) => d.items);
      const item = allItems.find((i) => i.name === 'Untyped deposit');
      expect(item).toBeDefined();
      expect(item?.direction).toBe('in');
      expect(item?.amount).toBe(123);
      expect(result.summary.totalIn).toBe(123);
    });
  });

  it('groups items across distinct dates and sorts ascending', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-grouping@test.com');
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '10.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Day 20',
          date: new Date(2026, 5, 20),
          domainType: 'recurring_bill',
          totalInstallments: 1,
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '10.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Day 5',
          date: new Date(2026, 5, 5),
          domainType: 'recurring_bill',
          totalInstallments: 1,
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '10.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Day 12',
          date: new Date(2026, 5, 12),
          domainType: 'recurring_bill',
          totalInstallments: 1,
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      expect(result.days.map((d) => d.date)).toEqual(['2026-06-05', '2026-06-12', '2026-06-20']);
      expect(result.days[0].items[0].name).toBe('Day 5');
      expect(result.days[1].items[0].name).toBe('Day 12');
      expect(result.days[2].items[0].name).toBe('Day 20');
    });
  });

  // H4: foreign-currency income is converted to BRL using the per-tx rate, or
  // the income_source_config rate as a fallback — so totalIn agrees with what
  // MonthSummaryService computes for the dashboard.
  it('converts USD income to BRL using the income_source_config rate', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-usd-income@test.com');
      await db.insert(incomeSourceConfigs).values({
        accountId: s.revenueId,
        frequency: 'monthly',
        category: 'salary_pj',
        exchangeRate: '5.000000',
      });
      await db.insert(transactions).values({
        userId: s.userId,
        sourceAccountId: s.revenueId,
        destinationAccountId: s.checkingId,
        amount: '100.00',
        currency: 'USD',
        type: 'deposit',
        description: 'USD salary',
        date: new Date(2026, 5, 5),
        domainType: 'income_pj',
      });

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const income = result.days.flatMap((d) => d.items).find((i) => i.kind === 'income');
      expect(income?.direction).toBe('in');
      expect(income?.amount).toBe(500); // 100 USD * 5.0
      expect(result.summary.totalIn).toBe(500);
    });
  });

  // H4 fail-loud: foreign income with no per-tx rate AND no config rate must throw.
  it('throws on foreign income with no exchange rate (fail-loud)', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-usd-norate@test.com');
      await db.insert(transactions).values({
        userId: s.userId,
        sourceAccountId: s.revenueId,
        destinationAccountId: s.checkingId,
        amount: '100.00',
        currency: 'USD',
        type: 'deposit',
        description: 'USD salary no rate',
        date: new Date(2026, 5, 5),
        domainType: 'income_pj',
      });

      const daily = await s.service.getDailyControl(s.userId, 6, 2026);
      expect(daily.summary).toMatchObject({ totalIn: 0, unavailableCount: 1 });
      expect(daily.days.flatMap((day) => day.items)[0].amountUnavailable).toBe(true);
    });
  });

  // Income lands on its MATERIALIZED occurrence date (the materializer already
  // applies the biweekly cadence + CLT business-day roll). Daily control no
  // longer overrides the date with the config paymentDay.
  it('places income on its materialized occurrence date, not the config paymentDay', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-payday@test.com');
      await db.insert(incomeSourceConfigs).values({
        accountId: s.revenueId,
        frequency: 'monthly',
        category: 'salary_clt',
        paymentDay: 15,
      });
      await db.insert(transactions).values({
        userId: s.userId,
        sourceAccountId: s.revenueId,
        destinationAccountId: s.checkingId,
        amount: '5000.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Salary',
        // Materialized date differs from paymentDay (e.g. business-day adjusted).
        date: new Date(2026, 5, 13),
        domainType: 'income_clt',
      });

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const income = result.days.flatMap((d) => d.items).find((i) => i.kind === 'income');
      // The materialized date wins, not paymentDay (15).
      expect(income?.date).toBe('2026-06-13');
    });
  });

  // M5: zero/negative-amount non-card rows must not produce an item. The DB
  // CHECK `tx_amount_positive` (amount > 0) prevents inserting a true zero row,
  // so the service-level guard is exercised against the smallest positive
  // amount (it must be KEPT) plus a normal row — proving the filter drops only
  // zero/negative and never a legitimate positive row.
  it('keeps positive non-card rows (zero/negative are unreachable + filtered)', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-zeroamt@test.com');
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '0.01',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Tiny charge',
          date: new Date(2026, 5, 3),
          domainType: 'recurring_bill',
          totalInstallments: 1,
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '42.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Real charge',
          date: new Date(2026, 5, 3),
          domainType: 'recurring_bill',
          totalInstallments: 1,
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const allItems = result.days.flatMap((d) => d.items);
      expect(allItems.some((i) => i.name === 'Tiny charge')).toBe(true);
      expect(allItems.some((i) => i.name === 'Real charge')).toBe(true);
      expect(result.summary.totalOut).toBe(42.01);
    });
  });

  // C5-daily: a credit_card-group row with a NULL billing month is dropped by
  // buildCardItems (billingMonth=month never matches NULL); it must still be
  // surfaced so no money vanishes (mirrors MonthSummary.nullBillingCardExpenses).
  it('surfaces a NULL-billingMonth credit_card row instead of dropping it', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-nullbilling@test.com');
      await db.insert(transactions).values({
        userId: s.userId,
        sourceAccountId: s.checkingId,
        destinationAccountId: s.cardId,
        amount: '77.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Orphan card charge',
        date: new Date(2026, 5, 8),
        billingMonth: null,
        billingYear: null,
        domainType: 'credit_card_expense',
      });

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const allItems = result.days.flatMap((d) => d.items);
      const orphan = allItems.find((i) => i.name === 'Orphan card charge');
      expect(orphan).toBeUndefined();
      expect(result.reviewIssues).toContainEqual(
        expect.objectContaining({ name: 'Orphan card charge', reason: 'unknown_cycle' }),
      );
      expect(result.summary.totalOut).toBe(0);
    });
  });

  // R10b: a card whose dueDay <= closingDay is DUE the calendar month AFTER its
  // billingMonth (computeFaturaDueDate). The seed card uses closingDay=1, dueDay=10
  // (same-month); here we add a card that closes June 28 / is due July 3. Its
  // June fatura (billingMonth=6) must appear in JULY's daily on 2026-07-03 — and
  // must NOT appear in JUNE's daily at all.
  it('places a next-month-due card fatura (dueDay<=closingDay) in the DUE month, not the billing month', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-nextmonth@test.com');
      const accountService = new AccountService(db);
      const nextDueCard = await accountService.create(s.userId, {
        name: 'NextDueCard',
        type: 'credit_card',
        currency: 'BRL',
      });
      // closingDay 28, dueDay 3 → dueDay <= closingDay → due month AFTER billingMonth.
      await db
        .insert(creditCardConfigs)
        .values({ accountId: nextDueCard.id, closingDay: 28, dueDay: 3 });
      await db.insert(transactions).values({
        userId: s.userId,
        sourceAccountId: s.checkingId,
        destinationAccountId: nextDueCard.id,
        amount: '400.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Parcela junho',
        date: new Date(2026, 5, 10),
        billingMonth: 6,
        billingYear: 2026,
        domainType: 'credit_card_installment',
      });

      // JULY: the June fatura (due 2026-07-03) appears here.
      const july = await s.service.getDailyControl(s.userId, 7, 2026);
      const julyCards = july.days
        .flatMap((d) => d.items)
        .filter((i) => i.kind === 'card' && i.id === nextDueCard.id);
      expect(julyCards.length).toBe(1);
      expect(julyCards[0].date).toBe('2026-07-03');
      expect(julyCards[0].amount).toBe(400);
      expect(julyCards[0].direction).toBe('out');

      // JUNE: it must NOT appear in the billing month.
      const june = await s.service.getDailyControl(s.userId, 6, 2026);
      const juneCards = june.days
        .flatMap((d) => d.items)
        .filter((i) => i.kind === 'card' && i.id === nextDueCard.id);
      expect(juneCards.length).toBe(0);
    });
  });

  // R10b: a same-month card (dueDay 20 > closingDay 10) is DUE in its own
  // billingMonth — its June fatura appears in JUNE's daily on 2026-06-20.
  it('places a same-month card fatura (dueDay>closingDay) in its billing month', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-samemonth@test.com');
      const accountService = new AccountService(db);
      const sameMonthCard = await accountService.create(s.userId, {
        name: 'SameMonthCard',
        type: 'credit_card',
        currency: 'BRL',
      });
      await db
        .insert(creditCardConfigs)
        .values({ accountId: sameMonthCard.id, closingDay: 10, dueDay: 20 });
      await db.insert(transactions).values({
        userId: s.userId,
        sourceAccountId: s.checkingId,
        destinationAccountId: sameMonthCard.id,
        amount: '250.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Compra junho',
        date: new Date(2026, 5, 5),
        billingMonth: 6,
        billingYear: 2026,
        domainType: 'credit_card_expense',
      });

      const june = await s.service.getDailyControl(s.userId, 6, 2026);
      const juneCards = june.days
        .flatMap((d) => d.items)
        .filter((i) => i.kind === 'card' && i.id === sameMonthCard.id);
      expect(juneCards.length).toBe(1);
      expect(juneCards[0].date).toBe('2026-06-20');
      expect(juneCards[0].amount).toBe(250);
      expect(juneCards[0].direction).toBe('out');
    });
  });

  // M1: a date-only column has no time-of-day; the pg driver returns it at UTC
  // midnight, so the UTC-constructed month window AND the UTC date-key both
  // include the 1st and the last day of the month. This proves the boundaries
  // are calendar-correct (no timezone off-by-one at either edge).
  it('includes transactions on the FIRST and LAST day of the month (boundary)', async () => {
    await withRollback(async (db) => {
      const s = await seed(db, 'daily-boundary@test.com');
      await db.insert(transactions).values([
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '11.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'First day',
          date: new Date(Date.UTC(2026, 5, 1)),
          domainType: 'recurring_bill',
          totalInstallments: 1,
        },
        {
          userId: s.userId,
          sourceAccountId: s.checkingId,
          destinationAccountId: s.expenseId,
          amount: '22.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Last day',
          date: new Date(Date.UTC(2026, 5, 30)), // June has 30 days
          domainType: 'recurring_bill',
          totalInstallments: 1,
        },
      ]);

      const result = await s.service.getDailyControl(s.userId, 6, 2026);
      const byName = new Map(result.days.flatMap((d) => d.items).map((i) => [i.name, i]));
      expect(byName.get('First day')?.date).toBe('2026-06-01');
      expect(byName.get('Last day')?.date).toBe('2026-06-30');
      expect(result.summary.totalOut).toBe(33);
    });
  });
});
