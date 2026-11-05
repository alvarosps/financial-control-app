import {
  accounts,
  financialEventRevisions,
  financialEvents,
  purchaseLedgerLinks,
  purchaseObservations,
  transactions,
} from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';

describe('purchase inbox schema', () => {
  it('isolates observations and refuses ledger links to another owner even through direct writes', async () => {
    await withRollback(async (db) => {
      const a = await createTestUser(db);
      const b = await createTestUser(db);
      const [card, expense, foreign] = await db
        .insert(accounts)
        .values([
          { userId: a.id, name: 'Card', type: 'credit_card' as const },
          { userId: a.id, name: 'Expense', type: 'expense' as const },
          { userId: b.id, name: 'Other card', type: 'credit_card' as const },
        ])
        .returning();
      const data = {
        userId: a.id,
        cardAccountId: card.id,
        description: 'Coffee',
        amount: '12.00',
        currency: 'BRL',
      };
      const [observation] = await db.insert(purchaseObservations).values(data).returning();
      await expect(
        db.transaction((tx) =>
          tx.insert(purchaseObservations).values({ ...data, cardAccountId: foreign.id }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      const [transaction] = await db
        .insert(transactions)
        .values({
          userId: a.id,
          sourceAccountId: expense.id,
          destinationAccountId: card.id,
          amount: '12.00',
          type: 'withdrawal',
          domainType: 'credit_card_expense',
          description: 'Coffee',
          date: new Date('2026-09-25'),
          billingMonth: 9,
          billingYear: 2026,
        })
        .returning();
      const [otherObservation] = await db
        .insert(purchaseObservations)
        .values({ ...data, userId: b.id, cardAccountId: foreign.id })
        .returning();
      await expect(
        db.transaction((tx) =>
          tx.insert(purchaseLedgerLinks).values({
            userId: b.id,
            observationId: otherObservation.id,
            transactionId: transaction.id,
            application: 'linked',
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      await db.insert(purchaseLedgerLinks).values({
        userId: a.id,
        observationId: observation.id,
        transactionId: transaction.id,
        application: 'linked',
      });
      const [duplicate] = await db.insert(purchaseObservations).values(data).returning();
      await expect(
        db.transaction((tx) =>
          tx.insert(purchaseLedgerLinks).values({
            userId: a.id,
            observationId: duplicate.id,
            transactionId: transaction.id,
            application: 'linked',
          }),
        ),
      ).rejects.toThrow();
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', ${b.id}, true)`);
      expect((await db.select().from(purchaseObservations)).map((row) => row.id)).toEqual([
        otherObservation.id,
      ]);
      expect(await db.select().from(purchaseLedgerLinks)).toHaveLength(0);
      await expect(
        db.transaction((tx) => tx.insert(purchaseObservations).values(data)),
      ).rejects.toThrow();
    });
  });

  it('preserves immutable event revisions and scopes stable identity per user and source', async () => {
    await withRollback(async (db) => {
      const user = await createTestUser(db);
      const [observation] = await db
        .insert(purchaseObservations)
        .values({ userId: user.id, description: 'Purchase', amount: '20.00' })
        .returning();
      const identity = {
        userId: user.id,
        observationId: observation.id,
        source: 'android' as const,
        sourceScope: 'device-1',
        externalId: 'id-1',
        currentVersion: 1,
        currentHash: 'a'.repeat(64),
      };
      const [event] = await db.insert(financialEvents).values(identity).returning();
      await expect(
        db.transaction((tx) => tx.insert(financialEvents).values(identity)),
      ).rejects.toThrow();
      await db.insert(financialEvents).values({ ...identity, sourceScope: 'device-2' });
      const [revision] = await db
        .insert(financialEventRevisions)
        .values({
          userId: user.id,
          eventId: event.id,
          sourceVersion: 1,
          contentHash: identity.currentHash,
          parserVersion: 'test-1',
          observedAt: new Date(),
          data: {
            cardAccountId: null,
            description: 'Purchase',
            amount: '20.00',
            currency: 'BRL',
            amountMeaning: 'unknown',
            kind: 'purchase',
            purchaseDate: null,
            postedDate: null,
            installmentNumber: null,
            totalInstallments: null,
            confirmation: 'observed',
          },
        })
        .returning();
      await expect(
        db.transaction((tx) =>
          tx
            .update(financialEventRevisions)
            .set({ parserVersion: 'changed' })
            .where(eq(financialEventRevisions.id, revision.id)),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(
        db.transaction((tx) =>
          tx.delete(financialEventRevisions).where(eq(financialEventRevisions.id, revision.id)),
        ),
      ).rejects.toThrow();
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', ${user.id}, true)`);
      expect(await db.select().from(financialEvents)).toHaveLength(2);
      expect(await db.select().from(financialEventRevisions)).toHaveLength(1);
    });
  });
});
