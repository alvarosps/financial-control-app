import { financialEventRevisions, purchaseObservations, transactions } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { FinancialEventService } from './financial-event.service.ts';

describe('FinancialEventService', () => {
  it.each([
    'revision',
    'merge',
  ] as const)('retains a current cancellation from another source during a %s', async (operation) => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const service = new FinancialEventService(db);
      const { transaction } = await new CreditCardFlowService(db, {
        capturePurchases: false,
      }).addOneTimeExpense(f.user.id, {
        creditCardAccountId: f.card.id,
        expenseAccountId: f.expense.id,
        description: 'Purchase',
        amount: '100.00',
        billingMonth: 9,
        billingYear: 2026,
      });
      const target = { transactionId: transaction.id };
      const original = await service.ingest(f.user.id, f.event);
      await service.attach(f.user.id, original.observation.id, target);
      const cancellation = {
        ...f.event,
        source: 'pdf' as const,
        externalId: 'cancelled-purchase',
        data: { ...f.event.data, confirmation: 'retracted' as const },
      };
      const cancelled = await service.ingest(f.user.id, cancellation);
      await service.attach(f.user.id, cancelled.observation.id, target);
      if (operation === 'revision') {
        await service.ingest(f.user.id, { ...f.event, sourceVersion: 2 });
      } else {
        const extra = await service.ingest(f.user.id, {
          ...f.event,
          externalId: 'other-proof',
          data: { ...f.event.data, confirmation: 'posted' },
        });
        await service.attach(f.user.id, extra.observation.id, target);
      }
      const [purchase] = await db
        .select()
        .from(purchaseObservations)
        .where(eq(purchaseObservations.id, original.observation.id));
      expect(purchase).toMatchObject({ confirmation: 'retracted', review: 'needs_review' });
      const reinstated = await service.ingest(f.user.id, {
        ...cancellation,
        sourceVersion: 2,
        data: { ...cancellation.data, confirmation: 'posted' },
      });
      expect(reinstated.observation.confirmation).toBe('posted');
      expect((await service.ingest(f.user.id, cancellation)).observation.confirmation).toBe(
        'posted',
      );
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(1);
    });
  });

  it('replays the same stable identity without another revision or purchase and rejects an ambiguous replay', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const service = new FinancialEventService(db);
      const first = await service.ingest(f.user.id, f.event);
      expect((await service.ingest(f.user.id, f.event)).observation.id).toBe(first.observation.id);
      expect(
        await db
          .select()
          .from(financialEventRevisions)
          .where(eq(financialEventRevisions.userId, f.user.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(purchaseObservations)
          .where(eq(purchaseObservations.userId, f.user.id)),
      ).toHaveLength(1);
      await expect(
        service.ingest(f.user.id, { ...f.event, data: { ...f.event.data, amount: '110.00' } }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(0);
    });
  });
  it('keeps two equal purchases distinct and uses explicit source versions rather than arrival order', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const service = new FinancialEventService(db);
      const first = await service.ingest(f.user.id, {
        ...f.event,
        sourceVersion: 3,
        data: { ...f.event.data, confirmation: 'posted' },
      });
      const old = await service.ingest(f.user.id, {
        ...f.event,
        sourceVersion: 2,
        data: { ...f.event.data, confirmation: 'pending' },
      });
      expect(old.observation.confirmation).toBe('posted');
      const second = await service.ingest(f.user.id, { ...f.event, externalId: 'purchase-2' });
      expect(second.observation.id).not.toBe(first.observation.id);
      expect(
        await db
          .select()
          .from(financialEventRevisions)
          .where(eq(financialEventRevisions.userId, f.user.id)),
      ).toHaveLength(3);
    });
  });
  it('rejects foreign-owner cards, raw payload fields and external sources that have not been enabled', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const other = await purchaseFixture(db);
      const service = new FinancialEventService(db);
      await expect(
        service.ingest(f.user.id, {
          ...f.event,
          data: { ...f.event.data, cardAccountId: other.card.id },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        service.ingest(f.user.id, {
          ...f.event,
          data: { ...f.event.data, rawNotification: 'private content' },
        }),
      ).rejects.toThrow();
      await expect(
        service.ingest(f.user.id, { ...f.event, source: 'android' }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });
  });
});
