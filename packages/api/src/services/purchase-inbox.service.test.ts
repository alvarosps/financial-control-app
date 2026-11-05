import {
  purchaseLedgerLinks,
  purchaseObservations,
  scheduledTransactions,
  transactions,
  userProfiles,
} from '@fc/db';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../test/pool.ts';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { FinancialEventService } from './financial-event.service.ts';
import { PurchaseInboxService } from './purchase-inbox.service.ts';
import { TransactionService } from './transaction.service.ts';

describe('PurchaseInboxService', () => {
  it('acknowledges a reviewed existing link without financial writes or a second link', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
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
      const later = await events.ingest(f.user.id, {
        ...f.event,
        sourceVersion: 2,
        data: { ...f.event.data, amount: '110.00' },
      });
      expect(later.observation.review).toBe('needs_review');
      const before = await db.select().from(transactions).where(eq(transactions.userId, f.user.id));
      const reviewed = await inbox.link(f.user.id, {
        observationId: applied.id,
        version: later.observation.version,
        target: { scheduleId: applied.link?.scheduleId ?? '' },
      });
      expect(reviewed.review).toBe('accepted');
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toEqual(before);
      expect(
        await db
          .select()
          .from(purchaseLedgerLinks)
          .where(eq(purchaseLedgerLinks.observationId, applied.id)),
      ).toHaveLength(1);
    });
  });
  it('preserves a manually corrected posting date through revisions and merged evidence', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const events = new FinancialEventService(db);
      const inbox = new PurchaseInboxService(db);
      const { observation } = await events.ingest(f.user.id, f.event);
      await inbox.review(f.user.id, {
        observationId: observation.id,
        version: 1,
        changes: { postedDate: '2026-09-21' },
      });
      const revised = await events.ingest(f.user.id, {
        ...f.event,
        sourceVersion: 2,
        data: { ...f.event.data, postedDate: '2026-09-22', confirmation: 'posted' },
      });
      expect(revised.observation.postedDate).toBe('2026-09-21');
      const applied = await inbox.accept(f.user.id, {
        observationId: revised.observation.id,
        version: revised.observation.version,
        expenseAccountId: f.expense.id,
        billingMonth: 9,
        billingYear: 2026,
      });
      const next = await events.ingest(f.user.id, {
        ...f.event,
        externalId: 'pdf-evidence',
        source: 'pdf',
        data: { ...f.event.data, postedDate: '2026-09-23', confirmation: 'posted' },
      });
      const merged = await inbox.link(f.user.id, {
        observationId: next.observation.id,
        version: 1,
        target: { scheduleId: applied.link?.scheduleId ?? '' },
      });
      expect(merged.postedDate).toBe('2026-09-21');
    });
  });
  it('serializes two tabs and simultaneous manual/PDF evidence on separate transactions', async () => {
    const root = getTestDb();
    const f = await root.transaction(purchaseFixture);
    try {
      const events = new FinancialEventService(root);
      const inbox = new PurchaseInboxService(root);
      const [first, replay] = await Promise.all([
        events.ingest(f.user.id, f.event),
        events.ingest(f.user.id, f.event),
      ]);
      expect(first.observation.id).toBe(replay.observation.id);
      const input = {
        observationId: first.observation.id,
        version: first.observation.version,
        expenseAccountId: f.expense.id,
        billingMonth: 9,
        billingYear: 2026,
      };
      const results = await Promise.allSettled([
        inbox.accept(f.user.id, input),
        inbox.accept(f.user.id, input),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
        { reason: { code: 'CONFLICT' } },
      ]);
      const [schedule] = await root
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.userId, f.user.id));
      const signals = await Promise.all(
        ['pdf', 'manual'].map((source) =>
          events.ingest(f.user.id, { ...f.event, source, externalId: `concurrent-${source}` }),
        ),
      );
      await Promise.all(
        signals.map(({ observation }) =>
          inbox.link(f.user.id, {
            observationId: observation.id,
            version: observation.version,
            target: { scheduleId: schedule.id },
          }),
        ),
      );
      expect((await inbox.list(f.user.id, {})).items).toHaveLength(1);
      expect((await inbox.detail(f.user.id, first.observation.id)).events).toHaveLength(3);
      expect(
        await root.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(3);
    } finally {
      await root.delete(userProfiles).where(eq(userProfiles.id, f.user.id));
    }
  });
  it('revokes provenance after a reversal without undoing or changing the ledger', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const inbox = new PurchaseInboxService(db);
      const { observation } = await new FinancialEventService(db).ingest(f.user.id, {
        ...f.event,
        data: {
          ...f.event.data,
          amountMeaning: 'purchase_total',
          installmentNumber: null,
          totalInstallments: null,
        },
      });
      const applied = await inbox.accept(f.user.id, {
        observationId: observation.id,
        version: 1,
        expenseAccountId: f.expense.id,
        billingMonth: 9,
        billingYear: 2026,
      });
      const id = applied.link?.transactionId;
      expect(id).toBeTruthy();
      await new TransactionService(db).reverse(f.user.id, id ?? '');
      const before = await db.select().from(transactions).where(eq(transactions.userId, f.user.id));
      expect(
        (await inbox.unlink(f.user.id, { observationId: applied.id, version: applied.version }))
          .application,
      ).toBe('unapplied');
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toEqual(before);
    });
  });
  it('blocks unknown amounts and foreign expense accounts and keeps ignored decisions on new revisions', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const other = await purchaseFixture(db);
      const events = new FinancialEventService(db);
      const inbox = new PurchaseInboxService(db);
      const { observation } = await events.ingest(f.user.id, {
        ...f.event,
        data: { ...f.event.data, amountMeaning: 'unknown' },
      });
      const apply = {
        observationId: observation.id,
        version: 1,
        expenseAccountId: f.expense.id,
        billingMonth: 9,
        billingYear: 2026,
      };
      await expect(inbox.accept(f.user.id, apply)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      const corrected = await inbox.review(f.user.id, {
        observationId: observation.id,
        version: 1,
        changes: { amountMeaning: 'installment' },
      });
      await expect(
        inbox.accept(f.user.id, {
          ...apply,
          version: corrected.version,
          expenseAccountId: other.expense.id,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await inbox.ignore(f.user.id, { observationId: corrected.id, version: corrected.version });
      const revised = await events.ingest(f.user.id, {
        ...f.event,
        sourceVersion: 2,
        data: { ...f.event.data, confirmation: 'posted' },
      });
      expect(revised.observation.review).toBe('ignored');
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(0);
    });
  });
  it('requires confirmation for a real equal purchase and keeps two financial series', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const events = new FinancialEventService(db);
      const inbox = new PurchaseInboxService(db);
      const first = await events.ingest(f.user.id, f.event);
      const apply = { expenseAccountId: f.expense.id, billingMonth: 9, billingYear: 2026 };
      await inbox.accept(f.user.id, { ...apply, observationId: first.observation.id, version: 1 });
      const second = await events.ingest(f.user.id, {
        ...f.event,
        externalId: 'real-second-purchase',
      });
      await expect(
        inbox.accept(f.user.id, { ...apply, observationId: second.observation.id, version: 1 }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await inbox.accept(f.user.id, {
        ...apply,
        observationId: second.observation.id,
        version: 1,
        confirmDistinct: true,
      });
      expect((await inbox.list(f.user.id, {})).items).toHaveLength(2);
      expect(
        await db
          .select()
          .from(scheduledTransactions)
          .where(eq(scheduledTransactions.userId, f.user.id)),
      ).toHaveLength(2);
    });
  });
  it('suggests and links installment 1/N to an existing schedule without another transaction', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const existing = await new CreditCardFlowService(db, {
        capturePurchases: false,
      }).addInstallment(f.user.id, {
        creditCardAccountId: f.card.id,
        expenseAccountId: f.expense.id,
        description: 'Laptop',
        amount: '100.00',
        totalInstallments: 3,
        currentInstallmentNumber: 1,
        currentBillingMonth: 9,
        currentBillingYear: 2026,
        purchaseDate: '2026-09-20',
      });
      const { observation } = await new FinancialEventService(db).ingest(f.user.id, f.event);
      const inbox = new PurchaseInboxService(db);
      const before = await db.select().from(transactions).where(eq(transactions.userId, f.user.id));
      const detail = await inbox.detail(f.user.id, observation.id);
      expect(
        detail.candidates.some((candidate) => candidate.scheduleId === existing.schedule.id),
      ).toBe(true);
      const linked = await inbox.link(f.user.id, {
        observationId: observation.id,
        version: observation.version,
        target: { scheduleId: existing.schedule.id },
      });
      expect(linked.application).toBe('linked');
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toEqual(before);
    });
  });
  it('creates one normalized series and prevents a second application from a stale tab', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const inbox = new PurchaseInboxService(db);
      const { observation } = await new FinancialEventService(db).ingest(f.user.id, f.event);
      const input = {
        observationId: observation.id,
        version: observation.version,
        expenseAccountId: f.expense.id,
        billingMonth: 9,
        billingYear: 2026,
      };
      expect((await inbox.accept(f.user.id, input)).application).toBe('created');
      await expect(inbox.accept(f.user.id, input)).rejects.toMatchObject({ code: 'CONFLICT' });
      const schedules = await db
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.userId, f.user.id));
      expect(schedules).toHaveLength(1);
      expect(schedules[0].startingOccurrence).toBe(1);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(3);
    });
  });
  it('protects a corrected accepted value from later revisions and keeps cancellations out of the ledger', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const events = new FinancialEventService(db);
      const inbox = new PurchaseInboxService(db);
      const { observation } = await events.ingest(f.user.id, f.event);
      const corrected = await inbox.review(f.user.id, {
        observationId: observation.id,
        version: observation.version,
        changes: { amount: '90.00' },
      });
      const applied = await inbox.accept(f.user.id, {
        observationId: corrected.id,
        version: corrected.version,
        expenseAccountId: f.expense.id,
        billingMonth: 9,
        billingYear: 2026,
      });
      const before = await db.select().from(transactions).where(eq(transactions.userId, f.user.id));
      const revised = await events.ingest(f.user.id, {
        ...f.event,
        sourceVersion: 2,
        data: { ...f.event.data, amount: '120.00', confirmation: 'retracted' },
      });
      expect(revised.observation).toMatchObject({ amount: '90.00', review: 'needs_review' });
      expect((await inbox.detail(f.user.id, applied.id)).purchase.application).toBe('created');
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toEqual(before);
    });
  });
  it('merges evidence by an explicitly selected ledger target while preserving identical distinct purchases', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
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
      const second = await events.ingest(f.user.id, { ...f.event, externalId: 'another-signal' });
      const [link] = await db
        .select()
        .from(purchaseLedgerLinks)
        .where(
          and(
            eq(purchaseLedgerLinks.observationId, applied.id),
            isNull(purchaseLedgerLinks.revokedAt),
          ),
        );
      expect(link.scheduleId).not.toBeNull();
      const merged = await inbox.link(f.user.id, {
        observationId: second.observation.id,
        version: 1,
        target: { scheduleId: link.scheduleId ?? '' },
      });
      expect(merged.id).toBe(applied.id);
      expect((await inbox.list(f.user.id, {})).items).toHaveLength(1);
      expect((await inbox.detail(f.user.id, merged.id)).events).toHaveLength(2);
    });
  });
  it('scopes cursor pages and all review actions to the current owner', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const other = await purchaseFixture(db);
      const events = new FinancialEventService(db);
      const inbox = new PurchaseInboxService(db);
      for (let i = 0; i < 3; i++)
        await events.ingest(f.user.id, { ...f.event, externalId: `item-${i}` });
      await events.ingest(other.user.id, other.event);
      const first = await inbox.list(f.user.id, { limit: 2 });
      const second = await inbox.list(f.user.id, {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(first.items).toHaveLength(2);
      expect(second.items).toHaveLength(1);
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
      await expect(
        inbox.ignore(other.user.id, {
          observationId: first.items[0].id,
          version: first.items[0].version,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const ignored = await inbox.ignore(f.user.id, {
        observationId: first.items[0].id,
        version: first.items[0].version,
      });
      expect(ignored.review).toBe('ignored');
      expect((await inbox.list(f.user.id, {})).counts.unreviewed).toBe(2);
      expect(
        await db
          .select()
          .from(purchaseObservations)
          .where(eq(purchaseObservations.userId, other.user.id)),
      ).toHaveLength(1);
    });
  });
});
