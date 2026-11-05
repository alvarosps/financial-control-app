import { financialEvents, purchaseLedgerLinks, transactions } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { DataCoverageService } from './data-coverage.service.ts';
import { FinancialEventService } from './financial-event.service.ts';
import { PurchaseInboxService } from './purchase-inbox.service.ts';

describe('purchase lifecycle acceptance', () => {
  it('separates a mistaken merge while preserving the original purchase link and checking owner/version', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const other = await purchaseFixture(db);
      const events = new FinancialEventService(db);
      const inbox = new PurchaseInboxService(db);
      const first = await events.ingest(f.user.id, f.event);
      const applied = await inbox.accept(f.user.id, {
        observationId: first.observation.id,
        version: 1,
        expenseAccountId: f.expense.id,
        billingMonth: 9,
        billingYear: 2026,
      });
      if (!applied.link?.scheduleId) throw new Error('Missing link');
      const second = await events.ingest(f.user.id, {
        ...f.event,
        source: 'pdf',
        externalId: 'different-real-purchase',
        data: { ...f.event.data, confirmation: 'posted' },
      });
      const merged = await inbox.link(f.user.id, {
        observationId: second.observation.id,
        version: 1,
        target: { scheduleId: applied.link.scheduleId },
      });
      const input = { observationId: merged.id, version: merged.version, eventId: second.event.id };
      await expect(inbox.separateEvidence(other.user.id, input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        inbox.separateEvidence(f.user.id, { ...input, version: merged.version - 1 }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const separated = await inbox.separateEvidence(f.user.id, input);
      expect(separated).toMatchObject({
        application: 'unapplied',
        review: 'needs_review',
        sources: ['pdf'],
      });
      const canonical = await inbox.detail(f.user.id, applied.id);
      expect(canonical.purchase.confirmation).toBe('observed');
      expect(canonical.purchase.link?.id).toBe(applied.link.id);
      expect(canonical.events.map((event) => event.id)).toEqual([first.event.id]);
      expect((await inbox.list(f.user.id, {})).items).toHaveLength(2);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(3);
      await expect(inbox.separateEvidence(f.user.id, input)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });
  });
  it('joins explicit manual, notification, pending/posted bank and PDF identities while preserving identical real purchases and retractions', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const flow = new CreditCardFlowService(db);
      const { transaction } = await flow.addOneTimeExpense(f.user.id, {
        creditCardAccountId: f.card.id,
        expenseAccountId: f.expense.id,
        description: 'Coffee',
        amount: '25.00',
        billingMonth: 9,
        billingYear: 2026,
        purchaseDate: '2026-09-20',
      });
      const events = new FinancialEventService(db, ['manual', 'pdf', 'android', 'pluggy']);
      const data = {
        ...f.event.data,
        description: 'Coffee',
        amount: '25.00',
        amountMeaning: 'purchase_total' as const,
        installmentNumber: null,
        totalInstallments: null,
      };
      const target = { transactionId: transaction.id };
      for (const source of ['android', 'pluggy', 'pdf'] as const) {
        await events.recordApplied(
          f.user.id,
          {
            ...f.event,
            source,
            externalId: `${source}-row`,
            data: {
              ...data,
              confirmation:
                source === 'pluggy' ? 'pending' : source === 'pdf' ? 'posted' : 'observed',
            },
          },
          target,
          'linked',
        );
        if (source === 'pluggy')
          await events.recordApplied(
            f.user.id,
            {
              ...f.event,
              source,
              externalId: 'pluggy-row',
              sourceVersion: 2,
              data: { ...data, confirmation: 'posted', postedDate: '2026-09-21' },
            },
            target,
            'linked',
          );
      }
      const inbox = new PurchaseInboxService(db);
      const joined = await inbox.list(f.user.id, {});
      expect(joined.items).toHaveLength(1);
      expect(joined.items[0]).toMatchObject({
        confirmation: 'posted',
        application: 'created',
        appliedAmount: '25.00',
      });
      expect(joined.items[0].sources.sort()).toEqual(['android', 'manual', 'pdf', 'pluggy']);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(1);
      await flow.addOneTimeExpense(f.user.id, {
        creditCardAccountId: f.card.id,
        expenseAccountId: f.expense.id,
        description: 'Coffee',
        amount: '25.00',
        billingMonth: 9,
        billingYear: 2026,
        purchaseDate: '2026-09-20',
      });
      expect((await inbox.list(f.user.id, {})).items).toHaveLength(2);
      await events.ingest(f.user.id, {
        ...f.event,
        source: 'pluggy',
        externalId: 'pluggy-row',
        sourceVersion: 3,
        data: { ...data, confirmation: 'retracted' },
      });
      expect((await inbox.detail(f.user.id, joined.items[0].id)).purchase).toMatchObject({
        confirmation: 'retracted',
        review: 'needs_review',
        appliedAmount: '25.00',
      });
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(2);
      await expect(
        new FinancialEventService(db).ingest(f.user.id, { ...f.event, source: 'pluggy' }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      const [coverage] = await new DataCoverageService(db).get(f.user.id);
      expect(coverage.sources.find((source) => source.source === 'pluggy')).toMatchObject({
        active: false,
        state: 'disabled',
      });
      expect((await inbox.list(f.user.id, {})).items).toHaveLength(2);
    });
  });

  it('resumes after ingestion without a ledger write and rolls back interruption during application', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const captured = await new FinancialEventService(db).ingest(f.user.id, f.event);
      const replay = await new FinancialEventService(db).ingest(f.user.id, f.event);
      expect(replay.observation.id).toBe(captured.observation.id);
      const input = {
        observationId: captured.observation.id,
        version: 1,
        expenseAccountId: f.expense.id,
        billingMonth: 9,
        billingYear: 2026,
      };
      await expect(
        db.transaction(async (tx) => {
          await new PurchaseInboxService(tx).accept(f.user.id, input);
          throw new Error('Interrupted before commit');
        }),
      ).rejects.toThrow('Interrupted before commit');
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(0);
      const result = await new PurchaseInboxService(db).accept(f.user.id, input);
      expect(result.appliedAmount).toBe('300.00');
      expect(
        await db.select().from(financialEvents).where(eq(financialEvents.userId, f.user.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(purchaseLedgerLinks)
          .where(eq(purchaseLedgerLinks.userId, f.user.id)),
      ).toHaveLength(1);
      await expect(new PurchaseInboxService(db).accept(f.user.id, input)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(3);
    });
  });
});
