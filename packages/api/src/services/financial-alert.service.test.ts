import { accounts, financialAlerts, purchaseObservations, transactions } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { BudgetService } from './budget.service.ts';
import { FinancialAlertService } from './financial-alert.service.ts';

describe('FinancialAlertService', () => {
  it('keeps alerts unresolved when a bounded scan cannot revisit their evidence', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db);
      await db.insert(purchaseObservations).values({
        userId: f.user.id,
        cardAccountId: f.card.id,
        description: 'Old unresolved',
        amount: '50.00',
        purchaseDate: '2026-09-01',
        unrecognized: true,
      });
      const service = new FinancialAlertService(db, () => new Date('2026-09-28T15:00:00Z'));
      const old = (await service.refresh(f.user.id)).items.find(
        (a) => a.rule === 'unrecognized_purchase',
      );
      if (!old) throw new Error('missing fixture');
      await db.insert(purchaseObservations).values(
        Array.from({ length: 1001 }, (_, i) => ({
          userId: f.user.id,
          cardAccountId: f.card.id,
          description: `New event ${i}`,
          amount: '1.00',
          purchaseDate: '2026-09-20',
        })),
      );
      expect((await service.refresh(f.user.id)).items.find((a) => a.id === old.id)).toMatchObject({
        active: true,
        state: 'open',
      });
    }));
  it('allows a projection warning only from recent reviewed cash and a complete expense basis', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      await db.insert(accounts).values({
        userId: user.id,
        name: 'Reviewed',
        type: 'checking',
        currency: 'BRL',
        openingBalance: '-100.00',
        openingBalanceAnchorAt: new Date('2026-09-28T12:00:00Z'),
        cashAnchorBasis: 'effective',
      });
      const rows = (
        await new FinancialAlertService(db, () => new Date('2026-09-28T15:00:00Z')).refresh(user.id)
      ).items;
      expect(rows).toMatchObject([
        { rule: 'projected_commitment', evidence: { amount: '-100.00' } },
      ]);
    }));
  it('keeps projection warnings unavailable when expected income lacks a BRL value', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [wallet, revenue] = await db
        .insert(accounts)
        .values([
          {
            userId: user.id,
            name: 'Reviewed',
            type: 'checking',
            currency: 'BRL',
            openingBalance: '-100.00',
            openingBalanceAnchorAt: new Date('2026-09-28T12:00:00Z'),
            cashAnchorBasis: 'effective',
          },
          { userId: user.id, name: 'Foreign income', type: 'revenue', currency: 'USD' },
        ])
        .returning();
      await db.insert(transactions).values({
        userId: user.id,
        sourceAccountId: revenue.id,
        destinationAccountId: wallet.id,
        amount: '1000.00',
        currency: 'USD',
        type: 'deposit',
        domainType: 'income_pj',
        description: 'Unvalued income',
        date: new Date('2026-09-30'),
      });
      const rows = (
        await new FinancialAlertService(db, () => new Date('2026-09-28T15:00:00Z')).refresh(user.id)
      ).items;
      expect(rows.map((row) => row.rule)).toContain('cash_coverage');
      expect(rows.map((row) => row.rule)).not.toContain('projected_commitment');
    }));
  it('deduplicates, retains read/mute state, and reopens changed or returning evidence using Sao Paulo month boundaries', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const [observation] = await db
        .insert(purchaseObservations)
        .values({
          userId: f.user.id,
          cardAccountId: f.card.id,
          description: 'Unknown store',
          amount: '50.00',
          amountMeaning: 'purchase_total',
          purchaseDate: '2026-09-20',
          unrecognized: true,
        })
        .returning();
      const service = new FinancialAlertService(db, () => new Date('2026-10-01T01:00:00Z'));
      const list = await service.refresh(f.user.id);
      const first = list.items.find((a) => a.rule === 'unrecognized_purchase');
      if (!first) throw new Error('missing alert');
      expect(first).toMatchObject({ month: 9, year: 2026, state: 'open' });
      const read = await service.setState(f.user.id, {
        id: first.id,
        revision: first.revision,
        state: 'read',
      });
      expect((await service.refresh(f.user.id)).items.find((a) => a.id === first.id)).toMatchObject(
        { state: 'read', revision: read.revision },
      );
      await db
        .update(purchaseObservations)
        .set({ amount: '60.00', version: 2 })
        .where(eq(purchaseObservations.id, observation.id));
      const changed = (await service.refresh(f.user.id)).items.find((a) => a.id === first.id);
      expect(changed).toMatchObject({ state: 'open', evidence: { amount: '60.00' } });
      if (!changed) throw new Error('missing alert');
      await expect(
        service.setState(f.user.id, { id: first.id, revision: first.revision, state: 'resolved' }),
      ).rejects.toThrow(/changed/i);
      await service.setState(f.user.id, {
        id: first.id,
        revision: changed.revision,
        state: 'muted',
      });
      await db
        .update(purchaseObservations)
        .set({ amount: '70.00', version: 3 })
        .where(eq(purchaseObservations.id, observation.id));
      expect((await service.refresh(f.user.id)).items.find((a) => a.id === first.id)?.state).toBe(
        'muted',
      );
      await db
        .update(purchaseObservations)
        .set({ unrecognized: false, version: 4 })
        .where(eq(purchaseObservations.id, observation.id));
      expect((await service.refresh(f.user.id)).items.find((a) => a.id === first.id)).toMatchObject(
        { state: 'resolved', active: false },
      );
      expect(
        await db.select().from(financialAlerts).where(eq(financialAlerts.id, first.id)),
      ).toHaveLength(1);
      const [inactive] = await db
        .select()
        .from(financialAlerts)
        .where(eq(financialAlerts.id, first.id));
      await expect(
        service.setState(f.user.id, {
          id: inactive.id,
          revision: inactive.revision,
          state: 'open',
        }),
      ).rejects.toThrow(/inactive/i);
    }));
  it('raises budget and past-observation alerts without creating financial entries or asserting unreliable cash', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db);
      await db.insert(accounts).values({
        userId: f.user.id,
        name: 'Unknown anchor',
        type: 'checking',
        openingBalance: '-100.00',
      });
      await new BudgetService(db).create(f.user.id, { month: 9, year: 2026, limitAmount: '90.00' });
      await db.insert(transactions).values({
        userId: f.user.id,
        sourceAccountId: f.expense.id,
        destinationAccountId: f.card.id,
        amount: '100.00',
        type: 'withdrawal',
        domainType: 'credit_card_expense',
        description: 'Purchase',
        date: new Date('2026-09-15'),
        billingMonth: 9,
        billingYear: 2026,
      });
      await db.insert(purchaseObservations).values(
        ['2026-07-05', '2026-08-05', '2026-09-05'].map((purchaseDate, index) => ({
          userId: f.user.id,
          cardAccountId: f.card.id,
          description: 'Service 123',
          amount: index === 2 ? '60.00' : '50.00',
          amountMeaning: 'purchase_total' as const,
          purchaseDate,
          confirmation: 'posted' as const,
        })),
      );
      const result = await new FinancialAlertService(
        db,
        () => new Date('2026-09-28T15:00:00Z'),
      ).refresh(f.user.id);
      expect(result.items.map((a) => a.rule)).toEqual(
        expect.arrayContaining([
          'stale_statement',
          'budget_exceeded',
          'recurring_price',
          'cash_coverage',
        ]),
      );
      expect(result.items.filter((a) => a.rule === 'projected_commitment')).toHaveLength(0);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(1);
    }));
  it('scopes decisions and database visibility to the owner', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db),
        other = await purchaseFixture(db);
      const service = new FinancialAlertService(db, () => new Date('2026-09-28T15:00:00Z'));
      const [row] = (await service.refresh(f.user.id)).items;
      await expect(
        service.setState(other.user.id, { id: row.id, revision: row.revision, state: 'muted' }),
      ).rejects.toThrow();
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', ${other.user.id}, true)`);
      expect(await db.select().from(financialAlerts).where(eq(financialAlerts.id, row.id))).toEqual(
        [],
      );
    }));
});
