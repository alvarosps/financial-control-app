import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '@fc/db';
import {
  accounts,
  externalAccounts,
  externalConnections,
  externalMovements,
  loanConfigs,
  monthClosings,
  monthClosingVersions,
  transactions,
} from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { FaturaImportService } from './fatura-import.service.ts';
import { FinancialEventService } from './financial-event.service.ts';
import { MonthClosingService } from './month-closing.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';
import { PurchaseInboxService } from './purchase-inbox.service.ts';

async function importedCardGroup(db: DbExecutor) {
  const f = await purchaseFixture(db);
  const { account: child } = await new CreditCardFlowService(db).createCreditCard(f.user.id, {
    name: 'Additional',
    closingDay: 24,
    dueDay: 8,
    parentAccountId: f.card.id,
  });
  const service = new FaturaImportService(db, { now: () => new Date('2026-09-28T15:00:00Z') });
  const statement = {
    closingDate: '2026-08-24',
    dueDate: '2026-09-08',
    statedTotal: '150.00',
    cards: [f.card, child].map((card, index) => ({
      lastFour: index ? '2222' : '1111',
      holderName: card.name,
      isAdditional: index === 1,
      items: [
        {
          description: index ? 'Child shop' : 'Parent shop',
          amountBRL: index ? '50.00' : '100.00',
          purchaseDate: '2026-08-10',
          installmentCurrent: null,
          installmentTotal: null,
          isRefund: false,
        },
      ],
    })),
  };
  const draft = await service.createManualDraft(f.user.id, {
    cardAccountId: f.card.id,
    provider: 'claude',
    responseJson: JSON.stringify(statement),
  });
  await service.apply(f.user.id, {
    importId: draft.id,
    expenseAccountId: f.expense.id,
    reviewedPeriod: { month: 8, year: 2026 },
    decisions: draft.itemsJson.suggestions.map((s, suggestionIndex) => ({
      kind: 'add_expense' as const,
      suggestionIndex,
      targetCardAccountId: s.parsed.isAdditional ? child.id : f.card.id,
      description: s.parsed.description,
      amount: s.parsed.amountBRL,
    })),
  });
  expect((await service.get(f.user.id, draft.id)).itemsJson.reconciliation?.status).toBe(
    'reconciled',
  );
  return { ...f, child, service, statement };
}

describe('reviewed monthly closing', () => {
  it('accepts one reconciled consolidated import for the parent and additional without duplicate manual proof', async () =>
    withRollback(async (db) => {
      const f = await importedCardGroup(db);
      const service = new MonthClosingService(db);
      const preview = await service.preview(f.user.id, 8, 2026);
      expect(preview.items).toContainEqual(
        expect.objectContaining({
          key: `card:${f.card.id}`,
          expected: '150.00',
          severity: 'ok',
          code: 'card_reconciled',
        }),
      );
      const waivers = Object.fromEntries(
        preview.items
          .filter((i) => i.severity === 'warning')
          .map((i) => [i.key, 'Reviewed synthetic exception']),
      );
      expect(
        await service.closeMonth(f.user.id, 8, 2026, 'Synthetic consolidated statement', {
          reviewHash: preview.reviewHash,
          waivers,
        }),
      ).toMatchObject({ totalExpenses: '150.00' });
    }));
  it('does not hide a known additional statement difference behind manual group proof', async () =>
    withRollback(async (db) => {
      const f = await importedCardGroup(db);
      const draft = await f.service.createManualDraft(f.user.id, {
        cardAccountId: f.child.id,
        provider: 'claude',
        responseJson: JSON.stringify({
          ...f.statement,
          statedTotal: '60.00',
          cards: [{ ...f.statement.cards[1], isAdditional: false }],
        }),
      });
      await f.service.apply(f.user.id, {
        importId: draft.id,
        expenseAccountId: f.expense.id,
        reviewedPeriod: { month: 8, year: 2026 },
        acknowledgeTotalMismatch: true,
        decisions: [],
      });
      expect((await f.service.get(f.user.id, draft.id)).itemsJson.reconciliation?.status).toBe(
        'difference',
      );
      expect(
        (
          await new MonthClosingService(db).preview(f.user.id, 8, 2026, {
            cards: [
              {
                accountId: f.card.id,
                totalAmount: '150.00',
                closingDate: '2026-08-24',
                dueDate: '2026-09-08',
                source: 'Synthetic app proof',
              },
            ],
          })
        ).items,
      ).toContainEqual(
        expect.objectContaining({
          key: `card:${f.card.id}`,
          code: 'card_difference',
          severity: 'critical',
        }),
      );
    }));
  it.each([
    'withdrawal',
    'deposit',
    'transfer',
  ] as const)('checks an archived wallet for an earlier competence settled in this month (%s)', async (type) =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [wallet, counterparty] = await db
        .insert(accounts)
        .values([
          { userId: user.id, name: 'Archived bank', type: 'checking', isActive: false },
          {
            userId: user.id,
            name: 'Counterparty',
            type: type === 'deposit' ? 'revenue' : type === 'transfer' ? 'checking' : 'expense',
          },
        ])
        .returning();
      await db.insert(transactions).values({
        userId: user.id,
        sourceAccountId: type === 'deposit' ? counterparty.id : wallet.id,
        destinationAccountId: type === 'deposit' ? wallet.id : counterparty.id,
        type,
        amount: '10.00',
        description: 'July settled in August',
        date: new Date('2026-07-10'),
        isPaid: true,
        cashAmount: '10.00',
        settlementSource: 'manual',
        settlementDate: new Date('2026-09-01T02:00:00Z'),
      });
      expect((await new MonthClosingService(db).preview(user.id, 8, 2026)).items).toContainEqual(
        expect.objectContaining({ key: `inactive_wallet:${wallet.id}`, severity: 'critical' }),
      );
    }));
  it('does not omit an archived wallet that has movements in the closing period', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [wallet, expense] = await db
        .insert(accounts)
        .values([
          { userId: user.id, name: 'Archived bank', type: 'checking', isActive: false },
          { userId: user.id, name: 'Expense', type: 'expense' },
        ])
        .returning();
      await db.insert(transactions).values({
        userId: user.id,
        sourceAccountId: wallet.id,
        destinationAccountId: expense.id,
        type: 'withdrawal',
        amount: '10.00',
        description: 'Historical movement',
        date: new Date('2026-08-10'),
      });
      expect((await new MonthClosingService(db).preview(user.id, 8, 2026)).items).toContainEqual(
        expect.objectContaining({ key: `inactive_wallet:${wallet.id}`, severity: 'critical' }),
      );
    }));
  it('blocks an unallocated payroll obligation even when no income occurrence exists', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [wallet, loan] = await db
        .insert(accounts)
        .values([
          { userId: user.id, name: 'Bank', type: 'checking' },
          { userId: user.id, name: 'Loan', type: 'loan' },
        ])
        .returning();
      await db.insert(loanConfigs).values({
        accountId: loan.id,
        loanCategory: 'bank',
        loanType: 'consignado',
        monthlyPayment: '100.00',
        totalInstallments: 12,
        dueDay: 25,
        monthlyInterestRate: '0',
        paymentMethod: 'payroll',
      });
      await db.insert(transactions).values({
        userId: user.id,
        sourceAccountId: wallet.id,
        destinationAccountId: loan.id,
        type: 'withdrawal',
        domainType: 'loan_payment',
        amount: '100.00',
        description: 'Unallocated payroll',
        date: new Date('2026-08-25'),
      });
      expect((await new MonthClosingService(db).preview(user.id, 8, 2026)).items).toContainEqual(
        expect.objectContaining({ key: 'payroll', severity: 'critical' }),
      );
    }));
  it('checks purchases after the previous closing day in their next billing month', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db);
      await new FinancialEventService(db).ingest(f.user.id, {
        ...f.event,
        data: { ...f.event.data, purchaseDate: '2026-07-25', confirmation: 'posted' },
      });
      expect((await new MonthClosingService(db).preview(f.user.id, 8, 2026)).items).toContainEqual(
        expect.objectContaining({ key: 'inbox', severity: 'critical' }),
      );
    }));
  it('preserves an already reopened legacy snapshot before closing it again', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      await db.insert(monthClosings).values({
        userId: user.id,
        month: 8,
        year: 2026,
        status: 'open',
        totalIncome: '123.00',
        totalExpenses: '99.00',
        detailedBreakdown: { original: true },
      });
      const service = new MonthClosingService(db);
      const preview = await service.preview(user.id, 8, 2026);
      await service.closeMonth(user.id, 8, 2026, 'Reclosing legacy evidence', {
        reviewHash: preview.reviewHash,
        waivers: { wallets: 'No wallet for synthetic user' },
      });
      const history = await db
        .select()
        .from(monthClosingVersions)
        .where(eq(monthClosingVersions.userId, user.id))
        .orderBy(monthClosingVersions.revision);
      expect(history).toHaveLength(2);
      expect(history[0].snapshot).toMatchObject({
        legacy: true,
        original: { totalIncome: '123.00', detailedBreakdown: { original: true } },
      });
    }));
  it('blocks imported bank movements awaiting reconciliation even when a manual balance matches', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [wallet] = await db
        .insert(accounts)
        .values({
          userId: user.id,
          name: 'Bank',
          type: 'checking',
          openingBalance: '100.00',
          openingBalanceAnchorAt: new Date('2026-08-01T03:00:00Z'),
          cashAnchorBasis: 'effective',
        })
        .returning();
      const [connection] = await db
        .insert(externalConnections)
        .values({ userId: user.id, itemId: randomUUID(), name: 'Synthetic' })
        .returning();
      const [external] = await db
        .insert(externalAccounts)
        .values({
          userId: user.id,
          connectionId: connection.id,
          externalId: randomUUID(),
          accountId: wallet.id,
          kind: 'BANK',
          name: 'Bank',
          currency: 'BRL',
        })
        .returning();
      const id = randomUUID();
      await db.insert(externalMovements).values({
        userId: user.id,
        externalAccountId: external.id,
        externalId: id,
        contentHash: 'a'.repeat(64),
        sourceUpdatedAt: new Date('2026-08-20'),
        payload: {
          id,
          accountId: external.externalId,
          description: 'Missing debit',
          amount: 10,
          currencyCode: 'BRL',
          type: 'DEBIT',
          status: 'POSTED',
          date: '2026-08-20',
          createdAt: '2026-08-20T12:00:00Z',
          updatedAt: '2026-08-20T12:00:00Z',
        },
      });
      const preview = await new MonthClosingService(db).preview(user.id, 8, 2026, {
        wallets: [{ accountId: wallet.id, amount: '100.00', source: 'Synthetic bank statement' }],
      });
      expect(preview.items).toContainEqual(
        expect.objectContaining({ key: 'bank_movements', severity: 'critical' }),
      );
    }));
  it('keeps a changed linked observation unresolved, and accepts ingestion after closure without changing the ledger', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const event = { ...f.event, data: { ...f.event.data, purchaseDate: '2026-08-20' } };
      const events = new FinancialEventService(db);
      const first = await events.ingest(f.user.id, event);
      await new PurchaseInboxService(db).accept(f.user.id, {
        observationId: first.observation.id,
        version: first.observation.version,
        expenseAccountId: f.expense.id,
        billingMonth: 8,
        billingYear: 2026,
      });
      await events.ingest(f.user.id, {
        ...event,
        sourceVersion: 2,
        data: { ...event.data, amount: '110.00' },
      });
      const service = new MonthClosingService(db);
      expect((await service.preview(f.user.id, 8, 2026)).items).toContainEqual(
        expect.objectContaining({ key: 'inbox', severity: 'critical' }),
      );
      await db
        .insert(monthClosings)
        .values({ userId: f.user.id, month: 8, year: 2026, status: 'closed' });
      const before = await db.select().from(transactions).where(eq(transactions.userId, f.user.id));
      const late = await events.ingest(f.user.id, {
        ...event,
        externalId: 'late',
        data: { ...event.data, amount: '77.00' },
      });
      await expect(
        new PurchaseInboxService(db).accept(f.user.id, {
          observationId: late.observation.id,
          version: late.observation.version,
          expenseAccountId: f.expense.id,
          billingMonth: 8,
          billingYear: 2026,
        }),
      ).rejects.toThrow(/closed/i);
      await events.ingest(f.user.id, {
        ...event,
        sourceVersion: 3,
        data: { ...event.data, amount: '120.00' },
      });
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toEqual(before);
    }));
  it('blocks a known wallet difference and retains immutable close/reopen revisions with reasons', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [wallet, expense] = await db
        .insert(accounts)
        .values([
          {
            userId: user.id,
            name: 'Bank',
            type: 'checking',
            openingBalance: '100.00',
            openingBalanceAnchorAt: new Date('2026-08-01T03:00:00Z'),
            cashAnchorBasis: 'effective',
          },
          { userId: user.id, name: 'Expense', type: 'expense' },
        ])
        .returning();
      await db.insert(transactions).values({
        userId: user.id,
        sourceAccountId: wallet.id,
        destinationAccountId: expense.id,
        type: 'withdrawal',
        amount: '10.00',
        description: 'Expense',
        date: new Date('2026-08-10'),
        isPaid: true,
        cashAmount: '10.00',
        settlementSource: 'manual',
        settlementDate: new Date('2026-08-10T15:00:00Z'),
      });
      const service = new MonthClosingService(db);
      const bad = {
        wallets: [{ accountId: wallet.id, amount: '95.00', source: 'Synthetic bank statement' }],
        cards: [],
        waivers: {},
      };
      const mismatch = await service.preview(user.id, 8, 2026, bad);
      expect(mismatch.items).toContainEqual(
        expect.objectContaining({ key: `wallet:${wallet.id}`, severity: 'critical' }),
      );
      await expect(
        service.closeMonth(user.id, 8, 2026, 'Reviewed synthetic period', {
          ...bad,
          reviewHash: mismatch.reviewHash,
        }),
      ).rejects.toThrow(/checklist/i);
      const good = { ...bad, wallets: [{ ...bad.wallets[0], amount: '90.00' }] };
      const preview = await service.preview(user.id, 8, 2026, good);
      const waivers = Object.fromEntries(
        preview.items
          .filter((item) => item.severity === 'warning')
          .map((item) => [item.key, 'Reviewed synthetic exception']),
      );
      const closed = await service.closeMonth(user.id, 8, 2026, 'Reviewed synthetic period', {
        ...good,
        waivers,
        reviewHash: preview.reviewHash,
      });
      expect(closed).toMatchObject({ revision: 1, totalExpenses: '10.00', totalIncome: '0.00' });
      expect(await new MonthSummaryService(db).getSummary(user.id, 8, 2026)).toMatchObject({
        totalExpenses: 10,
        totalIncome: 0,
      });
      await expect(service.reopenMonth(user.id, 8, 2026, '')).rejects.toThrow(/reason/i);
      await service.reopenMonth(user.id, 8, 2026, 'Correct supporting evidence', 1);
      const versions = await db
        .select()
        .from(monthClosingVersions)
        .where(eq(monthClosingVersions.userId, user.id))
        .orderBy(monthClosingVersions.revision);
      expect(versions.map((v) => v.action)).toEqual(['closed', 'reopened']);
      expect(versions[0].snapshot).toMatchObject({
        ruleVersion: 1,
        basis: 'expense_competence',
        totals: { expenses: '10.00' },
        waivers,
      });
      await expect(
        db.transaction((tx) =>
          tx
            .update(monthClosingVersions)
            .set({ reason: 'overwrite' })
            .where(eq(monthClosingVersions.id, versions[0].id)),
        ),
      ).rejects.toMatchObject({ cause: { message: expect.stringContaining('immutable') } });
    }));
  it('accepts reviewed card evidence without a PDF and rejects a stale review hash', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [card, expense] = await db
        .insert(accounts)
        .values([
          { userId: user.id, name: 'Card', type: 'credit_card' },
          { userId: user.id, name: 'Expense', type: 'expense' },
        ])
        .returning();
      const [row] = await db
        .insert(transactions)
        .values({
          userId: user.id,
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          type: 'transfer',
          domainType: 'credit_card_expense',
          amount: '100.00',
          description: 'Shop',
          date: new Date('2026-08-05'),
          billingMonth: 8,
          billingYear: 2026,
        })
        .returning();
      const service = new MonthClosingService(db);
      const review = {
        wallets: [],
        cards: [
          {
            accountId: card.id,
            totalAmount: '100.00',
            closingDate: '2026-08-20',
            dueDate: '2026-09-05',
            source: 'Reviewed bank app',
          },
        ],
        waivers: {},
      };
      const preview = await service.preview(user.id, 8, 2026, review);
      expect(preview.items).toContainEqual(
        expect.objectContaining({ key: `card:${card.id}`, severity: 'ok' }),
      );
      const waivers = Object.fromEntries(
        preview.items
          .filter((item) => item.severity === 'warning')
          .map((item) => [item.key, 'Reviewed synthetic exception']),
      );
      await db
        .update(transactions)
        .set({ description: 'Changed after preview' })
        .where(eq(transactions.id, row.id));
      await expect(
        service.closeMonth(user.id, 8, 2026, 'Reviewed synthetic period', {
          ...review,
          waivers,
          reviewHash: preview.reviewHash,
        }),
      ).rejects.toThrow(/changed/i);
      const refreshed = await service.preview(user.id, 8, 2026, review);
      expect(
        await service.closeMonth(user.id, 8, 2026, 'Reviewed synthetic period', {
          ...review,
          waivers,
          reviewHash: refreshed.reviewHash,
        }),
      ).toMatchObject({ totalExpenses: '100.00', revision: 1 });
    }));
});
