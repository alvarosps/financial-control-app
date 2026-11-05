import {
  financialEvents,
  purchaseLedgerLinks,
  purchaseObservations,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import type { ParsedFatura } from '@fc/domain';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { FaturaImportService } from './fatura-import.service.ts';
import { MaterializerService } from './materializer.service.ts';
import { PurchaseInboxService } from './purchase-inbox.service.ts';

const pdf = await PDFDocument.create();
pdf.addPage();
const pdfBase64 = await pdf.saveAsBase64();

describe('purchase adapters', () => {
  it('preserves reviewed PDF installment metadata in the canonical purchase while retaining the original evidence', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const statement: ParsedFatura = {
        dueDate: '2026-10-08',
        closingDate: '2026-09-24',
        statedTotal: '100.00',
        cards: [
          {
            lastFour: null,
            holderName: null,
            isAdditional: false,
            items: [
              {
                description: 'Parser description',
                amountBRL: '100.00',
                purchaseDate: '2026-09-20',
                installmentCurrent: null,
                installmentTotal: null,
                isRefund: false,
              },
            ],
          },
        ],
      };
      const importer = new FaturaImportService(db, {
        parser: { model: 'fixture', parse: async () => statement },
        now: () => new Date('2026-09-25T12:00:00Z'),
      });
      const draft = await importer.createDraft(f.user.id, {
        cardAccountId: f.card.id,
        fileName: 'corrected.pdf',
        pdfBase64,
        externalConsent: true,
      });
      await importer.apply(f.user.id, {
        importId: draft.id,
        expenseAccountId: f.expense.id,
        reviewedPeriod: { month: 9, year: 2026 },
        decisions: [
          {
            kind: 'add_installment',
            suggestionIndex: 0,
            targetCardAccountId: f.card.id,
            description: 'Reviewed laptop',
            amount: '100.00',
            currentInstallmentNumber: 1,
            totalInstallments: 3,
          },
        ],
      });
      const inbox = new PurchaseInboxService(db);
      const { items } = await inbox.list(f.user.id, {});
      expect(items[0]).toMatchObject({
        description: 'Reviewed laptop',
        amountMeaning: 'installment',
        installmentNumber: 1,
        totalInstallments: 3,
        estimatedTotal: '300.00',
        appliedAmount: '300.00',
        manuallyCorrected: true,
      });
      expect(
        (await inbox.detail(f.user.id, items[0].id)).events[0].revisions[0].data,
      ).toMatchObject({
        description: 'Parser description',
        amountMeaning: 'purchase_total',
        installmentNumber: null,
        totalInstallments: null,
      });
    });
  });
  it('captures one manual installment purchase and preserves its link through rematerialization', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const { schedule } = await new CreditCardFlowService(db).addInstallment(f.user.id, {
        creditCardAccountId: f.card.id,
        expenseAccountId: f.expense.id,
        amount: '100.00',
        description: 'Laptop',
        totalInstallments: 3,
        currentInstallmentNumber: 1,
        currentBillingMonth: 9,
        currentBillingYear: 2026,
        purchaseDate: '2026-09-20',
      });
      const inbox = new PurchaseInboxService(db);
      const before = await inbox.list(f.user.id, {});
      expect(before.items).toHaveLength(1);
      expect(before.items[0]).toMatchObject({
        sources: ['manual'],
        application: 'created',
        estimatedTotal: '300.00',
        purchaseDate: '2026-09-20',
        confirmation: 'observed',
      });
      await new MaterializerService(db).materializeScheduleChanges(f.user.id, {
        scope: 'targeted',
        fillScheduleIds: [],
        rebuildScheduleIds: [schedule.id],
        horizonMonths: 12,
      });
      expect((await inbox.list(f.user.id, {})).items.map((item) => item.id)).toEqual([
        before.items[0].id,
      ]);
      expect((await inbox.detail(f.user.id, before.items[0].id)).purchase.link?.scheduleId).toBe(
        schedule.id,
      );
    });
  });

  it('combines applied manual/PDF evidence, keeps identical items distinct and replays the PDF atomically', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      await new CreditCardFlowService(db).addOneTimeExpense(f.user.id, {
        creditCardAccountId: f.card.id,
        expenseAccountId: f.expense.id,
        amount: '25.00',
        description: 'Coffee',
        billingMonth: 9,
        billingYear: 2026,
        purchaseDate: '2026-09-20',
      });
      const statement: ParsedFatura = {
        dueDate: '2026-10-08',
        closingDate: '2026-09-24',
        statedTotal: '50.00',
        cards: [
          {
            lastFour: null,
            holderName: null,
            isAdditional: false,
            items: [0, 1].map(() => ({
              description: 'Coffee',
              amountBRL: '25.00',
              purchaseDate: '2026-09-20',
              installmentCurrent: null,
              installmentTotal: null,
              isRefund: false,
            })),
          },
        ],
      };
      const service = new FaturaImportService(db, {
        parser: { model: 'fixture', parse: async () => statement },
        now: () => new Date('2026-09-25T12:00:00Z'),
      });
      const draft = await service.createDraft(f.user.id, {
        cardAccountId: f.card.id,
        fileName: 'statement.pdf',
        pdfBase64,
        externalConsent: true,
      });
      const input = {
        importId: draft.id,
        expenseAccountId: f.expense.id,
        reviewedPeriod: { month: 9, year: 2026 },
        decisions: draft.itemsJson.suggestions.map((item, suggestionIndex) => ({
          kind: 'add_expense' as const,
          suggestionIndex,
          targetCardAccountId: f.card.id,
          description: item.parsed.description,
          amount: item.parsed.amountBRL,
        })),
      };
      await service.apply(f.user.id, input);
      await service.apply(f.user.id, input);
      const inbox = await new PurchaseInboxService(db).list(f.user.id, {});
      expect(inbox.items).toHaveLength(2);
      expect(
        inbox.items.filter(
          (item) => item.sources.includes('manual') && item.sources.includes('pdf'),
        ),
      ).toHaveLength(1);
      expect(inbox.items.every((item) => item.confirmation === 'posted')).toBe(true);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(2);
      expect(
        await db.select().from(financialEvents).where(eq(financialEvents.userId, f.user.id)),
      ).toHaveLength(3);
    });
  });

  it('rolls back manual provenance and financial writes together and leaves unknown legacy dates unknown', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      await expect(
        db.transaction(async (tx) => {
          await new CreditCardFlowService(tx).addOneTimeExpense(f.user.id, {
            creditCardAccountId: f.card.id,
            expenseAccountId: f.expense.id,
            amount: '10.00',
            description: 'Unknown date',
            billingMonth: 9,
            billingYear: 2026,
          });
          expect(
            (await new PurchaseInboxService(tx).list(f.user.id, {})).items[0].purchaseDate,
          ).toBeNull();
          throw new Error('interrupt after capture');
        }),
      ).rejects.toThrow('interrupt after capture');
      expect(
        await db
          .select()
          .from(purchaseObservations)
          .where(eq(purchaseObservations.userId, f.user.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(purchaseLedgerLinks)
          .where(eq(purchaseLedgerLinks.userId, f.user.id)),
      ).toHaveLength(0);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(scheduledTransactions)
          .where(eq(scheduledTransactions.userId, f.user.id)),
      ).toHaveLength(0);
    });
  });
});
