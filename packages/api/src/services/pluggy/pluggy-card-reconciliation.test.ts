import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '@fc/db';
import {
  creditCardBills,
  externalAccounts,
  externalBills,
  externalConnections,
  externalMovements,
  financialEvents,
  purchaseObservations,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { purchaseFixture } from '../../test/purchase-fixture.ts';
import { withRollback } from '../../test/with-rollback.ts';
import { CreditCardFlowService } from '../credit-card-flow.service.ts';
import { FinancialEventService } from '../financial-event.service.ts';
import { PurchaseInboxService } from '../purchase-inbox.service.ts';
import { claimIntegrationJob } from './integration-job.service.ts';
import { PluggyCardReconciliationService } from './pluggy-card-reconciliation.service.ts';
import { PluggyClient } from './pluggy-client.ts';
import { PluggyConnectionService } from './pluggy-connection.service.ts';
import { PluggySyncService } from './pluggy-sync.service.ts';

async function setup(db: DbExecutor) {
  const f = await purchaseFixture(db);
  const [connection] = await db
    .insert(externalConnections)
    .values({ userId: f.user.id, itemId: randomUUID(), name: 'Fixture' })
    .returning();
  const [account] = await db
    .insert(externalAccounts)
    .values({
      userId: f.user.id,
      connectionId: connection.id,
      externalId: randomUUID(),
      kind: 'CREDIT',
      name: 'Fixture',
      currency: 'BRL',
      accountId: f.card.id,
    })
    .returning();
  const payload = {
    id: randomUUID(),
    accountId: account.externalId,
    providerId: 'institution-identity',
    description: 'Laptop',
    amount: -100,
    currencyCode: 'BRL',
    type: 'DEBIT',
    status: 'PENDING',
    date: '2026-09-20',
    createdAt: '2026-09-20T10:00:00Z',
    updatedAt: '2026-09-20T10:00:00Z',
    creditCardMetadata: { installmentNumber: 1, totalInstallments: 3, purchaseDate: '2026-09-20' },
  };
  const [movement] = await db
    .insert(externalMovements)
    .values({
      userId: f.user.id,
      externalAccountId: account.id,
      externalId: payload.id,
      payload,
      contentHash: 'a'.repeat(64),
      sourceUpdatedAt: new Date(payload.updatedAt),
    })
    .returning();
  return {
    f,
    account,
    payload,
    movement,
    service: new PluggyCardReconciliationService(db),
    inbox: new PurchaseInboxService(db),
  };
}
describe('Pluggy card reconciliation', () => {
  it('shows institutional statement dates and rejects applying a purchase to a contradictory cycle', async () => {
    await withRollback(async (db) => {
      const { f, account, payload, movement, service, inbox } = await setup(db);
      const billId = randomUUID();
      await db.insert(externalBills).values({
        userId: f.user.id,
        externalAccountId: account.id,
        externalId: billId,
        payload: {
          id: billId,
          dueDate: '2026-10-08',
          billClosingDate: '2026-09-24',
          totalAmount: 100,
          totalAmountCurrencyCode: 'BRL',
        },
      });
      await db
        .update(externalMovements)
        .set({
          payload: {
            ...payload,
            status: 'POSTED',
            creditCardMetadata: { billId, purchaseDate: '2026-09-20', cardNumber: '1234' },
          },
        })
        .where(eq(externalMovements.id, movement.id));
      const observed = await service.publish(f.user.id, movement.id);
      if (!observed) throw new Error('Expected purchase');
      const detail = await inbox.detail(f.user.id, observed.observation.id);
      expect(detail).toMatchObject({
        institutionEvidence: [
          {
            cardLastFour: '1234',
            cycle: {
              billingMonth: 9,
              billingYear: 2026,
              closingDate: '2026-09-24',
              dueDate: '2026-10-08',
              confidence: 'confirmed',
            },
          },
        ],
      });
      const input = {
        observationId: observed.observation.id,
        version: observed.observation.version,
        expenseAccountId: f.expense.id,
        billingMonth: 10,
        billingYear: 2026,
      };
      await expect(inbox.accept(f.user.id, input)).rejects.toMatchObject({ code: 'CONFLICT' });
      await inbox.accept(f.user.id, { ...input, billingMonth: 9 });
      const [bill] = await db
        .select()
        .from(creditCardBills)
        .where(
          and(
            eq(creditCardBills.creditCardAccountId, f.card.id),
            eq(creditCardBills.month, 9),
            eq(creditCardBills.year, 2026),
          ),
        );
      expect(bill).toMatchObject({
        closingDate: '2026-09-24',
        dueDate: '2026-10-08',
        closingDateSource: 'institution',
        dueDateSource: 'institution',
      });
    });
  });
  it('republishes staged evidence after explicit account mapping through a durable owned job', async () => {
    await withRollback(async (db) => {
      const { f, movement, account, service } = await setup(db);
      await db
        .update(externalAccounts)
        .set({ accountId: null })
        .where(eq(externalAccounts.id, account.id));
      expect((await service.publish(f.user.id, movement.id))?.observation.cardAccountId).toBeNull();
      const client = new PluggyClient({
        clientId: 'fixture',
        clientSecret: 'fixture',
        fetcher: async () => {
          throw new Error('Mapping replay must not fetch the provider');
        },
      });
      await new PluggyConnectionService(db, client, []).mapAccount(
        f.user.id,
        account.id,
        f.card.id,
      );
      const lease = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE integration_scheduler`);
        const claim = await claimIntegrationJob(tx);
        await tx.execute(sql`RESET ROLE`);
        if (!claim) throw new Error('Missing replay job');
        return claim;
      });
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        expect(await new PluggySyncService(tx, client).step(lease)).toEqual({
          status: 'completed',
        });
        await tx.execute(sql`RESET ROLE`);
      });
      const observations = await db
        .select()
        .from(purchaseObservations)
        .where(eq(purchaseObservations.userId, f.user.id));
      expect(observations).toHaveLength(1);
      expect(observations[0].cardAccountId).toBe(f.card.id);
    });
  });
  it('replays and advances evidence on the same observation without creating installments', async () => {
    await withRollback(async (db) => {
      const { f, payload, movement, service } = await setup(db);
      const first = await service.publish(f.user.id, movement.id);
      expect(first?.observation).toMatchObject({
        amountMeaning: 'unknown',
        confirmation: 'pending',
      });
      expect((await service.publish(f.user.id, movement.id))?.replayed).toBe(true);
      await db
        .update(externalMovements)
        .set({ payload: { ...payload, status: 'POSTED' }, version: 2 })
        .where(eq(externalMovements.id, movement.id));
      const posted = await service.publish(f.user.id, movement.id);
      expect(posted?.observation.id).toBe(first?.observation.id);
      expect(posted?.observation.confirmation).toBe('posted');
      await db
        .update(externalMovements)
        .set({ retractedAt: new Date(), version: 3 })
        .where(eq(externalMovements.id, movement.id));
      expect((await service.publish(f.user.id, movement.id))?.observation.confirmation).toBe(
        'retracted',
      );
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(scheduledTransactions)
          .where(eq(scheduledTransactions.userId, f.user.id)),
      ).toHaveLength(0);
      const other = await purchaseFixture(db);
      await expect(service.publish(other.user.id, movement.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
  it('requires explicit links for changed provider IDs and preserves one manual/Android/Pluggy/PDF series', async () => {
    await withRollback(async (db) => {
      const { f, payload, movement, service, inbox } = await setup(db);
      const { schedule } = await new CreditCardFlowService(db).addInstallment(f.user.id, {
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
      await new FinancialEventService(db, ['android']).recordApplied(
        f.user.id,
        { ...f.event, source: 'android', sourceScope: 'fixture-device' },
        { scheduleId: schedule.id },
        'linked',
      );
      const pending = await service.publish(f.user.id, movement.id);
      if (!pending) throw new Error('Expected purchase');
      expect(
        (await inbox.detail(f.user.id, pending.observation.id)).candidates.some(
          (row) => row.scheduleId === schedule.id,
        ),
      ).toBe(true);
      await inbox.link(f.user.id, {
        observationId: pending.observation.id,
        version: pending.observation.version,
        target: { scheduleId: schedule.id },
      });
      const [postedMovement] = await db
        .insert(externalMovements)
        .values({
          ...movement,
          id: randomUUID(),
          externalId: randomUUID(),
          payload: { ...payload, id: randomUUID(), status: 'POSTED' },
        })
        .returning();
      // Keep envelope and payload identity consistent with the institutional response.
      await db
        .update(externalMovements)
        .set({ payload: { ...payload, id: postedMovement.externalId, status: 'POSTED' } })
        .where(eq(externalMovements.id, postedMovement.id));
      const posted = await service.publish(f.user.id, postedMovement.id);
      if (!posted) throw new Error('Expected posted purchase');
      expect((await inbox.list(f.user.id, {})).items).toHaveLength(2);
      expect(await inbox.detail(f.user.id, posted.observation.id)).toMatchObject({
        relatedPurchases: [{ description: 'Laptop', sameInstitutionalReference: true }],
      });
      await inbox.link(f.user.id, {
        observationId: posted.observation.id,
        version: posted.observation.version,
        target: { scheduleId: schedule.id },
      });
      await new FinancialEventService(db).recordApplied(
        f.user.id,
        {
          ...f.event,
          source: 'pdf',
          externalId: 'statement-fixture',
          data: { ...f.event.data, confirmation: 'posted' },
        },
        { scheduleId: schedule.id },
        'linked',
      );
      const items = (await inbox.list(f.user.id, {})).items;
      expect(items).toHaveLength(1);
      expect(items[0].sources.sort()).toEqual(['android', 'manual', 'pdf', 'pluggy']);
      expect(
        await db
          .select()
          .from(scheduledTransactions)
          .where(eq(scheduledTransactions.userId, f.user.id)),
      ).toHaveLength(1);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(3);
      expect(
        await db
          .select()
          .from(financialEvents)
          .where(and(eq(financialEvents.userId, f.user.id), eq(financialEvents.source, 'pluggy'))),
      ).toHaveLength(2);
    });
  });
});
