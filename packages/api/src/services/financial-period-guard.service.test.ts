import { accounts, monthClosings, purchaseLedgerLinks, transactions } from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { FinancialEventService } from './financial-event.service.ts';
import { FinancialPeriodGuard } from './financial-period-guard.service.ts';
import { MaterializerService } from './materializer.service.ts';
import { ScheduledService } from './scheduled.service.ts';

describe('FinancialPeriodGuard', () => {
  it('allows linking a future recurring occurrence without reopening previous occurrences', async () =>
    withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const events = new FinancialEventService(db);
      const schedule = await new ScheduledService(db).create(f.user.id, {
        sourceAccountId: f.expense.id,
        destinationAccountId: f.card.id,
        amount: '100.00',
        description: 'Monthly subscription',
        domainType: 'credit_card_fixed_charge',
        frequency: 'monthly',
        startDate: new Date('2026-08-20'),
        dueDay: 20,
      });
      await new MaterializerService(db).materializeSchedules(f.user.id, [schedule.id], 3);
      await db
        .insert(monthClosings)
        .values({ userId: f.user.id, month: 8, year: 2026, status: 'closed' });
      const next = await events.ingest(f.user.id, {
        ...f.event,
        externalId: 'next-subscription',
        data: {
          ...f.event.data,
          installmentNumber: null,
          totalInstallments: null,
          amountMeaning: 'purchase_total',
        },
      });
      await db.insert(purchaseLedgerLinks).values({
        userId: f.user.id,
        observationId: next.observation.id,
        scheduleId: schedule.id,
        billingMonth: 9,
        billingYear: 2026,
        application: 'linked',
      });
      expect(
        await db
          .select()
          .from(purchaseLedgerLinks)
          .where(eq(purchaseLedgerLinks.observationId, next.observation.id)),
      ).toHaveLength(1);
    }));
  it('protects old and new competence and settlement periods even for direct SQL writes', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [wallet, expense] = await db
        .insert(accounts)
        .values([
          { userId: user.id, name: 'Bank', type: 'checking' },
          { userId: user.id, name: 'Expense', type: 'expense' },
        ])
        .returning();
      const [row] = await db
        .insert(transactions)
        .values({
          userId: user.id,
          sourceAccountId: wallet.id,
          destinationAccountId: expense.id,
          type: 'withdrawal',
          amount: '10.00',
          description: 'Before close',
          date: new Date('2026-08-20'),
        })
        .returning();
      await db
        .insert(monthClosings)
        .values({ userId: user.id, month: 8, year: 2026, status: 'closed' });
      await expect(
        new FinancialPeriodGuard(db).assertOpen(user.id, ['2026-08-01']),
      ).rejects.toThrow(/closed/i);
      await expect(
        db.transaction((tx) =>
          tx
            .update(transactions)
            .set({ date: new Date('2026-09-20') })
            .where(eq(transactions.id, row.id)),
        ),
      ).rejects.toMatchObject({ cause: { message: expect.stringContaining('closed') } });
      await expect(
        db.transaction((tx) =>
          tx.insert(transactions).values({
            userId: user.id,
            sourceAccountId: wallet.id,
            destinationAccountId: expense.id,
            type: 'withdrawal',
            amount: '10.00',
            description: 'Late',
            date: new Date('2026-09-20'),
            settlementDate: new Date('2026-08-20T15:00:00Z'),
          }),
        ),
      ).rejects.toMatchObject({ cause: { message: expect.stringContaining('closed') } });
      await new FinancialPeriodGuard(db).assertOpen(user.id, ['2026-09-01']);
      expect(
        (
          await db.select().from(transactions).where(eq(transactions.id, row.id))
        )[0].date.toISOString(),
      ).toContain('2026-08-20');
    }));
  it('preserves closed non-card occurrences while a future schedule changes and rebuilds', async () =>
    withRollback(async (db) => {
      const user = await createTestUser(db);
      const [wallet, expense] = await db
        .insert(accounts)
        .values([
          { userId: user.id, name: 'Bank', type: 'checking' },
          { userId: user.id, name: 'Expense', type: 'expense' },
        ])
        .returning();
      const scheduled = new ScheduledService(db);
      const row = await scheduled.create(user.id, {
        sourceAccountId: wallet.id,
        destinationAccountId: expense.id,
        amount: '100.00',
        description: 'Monthly',
        frequency: 'monthly',
        startDate: new Date('2026-08-10'),
        dueDay: 10,
      });
      const materializer = new MaterializerService(db);
      await materializer.materializeSchedules(user.id, [row.id], 3);
      const [before] = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.userId, user.id), eq(transactions.date, new Date('2026-08-10'))),
        );
      await db
        .insert(monthClosings)
        .values({ userId: user.id, month: 8, year: 2026, status: 'closed' });
      await scheduled.update(user.id, row.id, { amount: '120.00' });
      await materializer.materializeScheduleChanges(user.id, {
        scope: 'targeted',
        fillScheduleIds: [],
        rebuildScheduleIds: [row.id],
        horizonMonths: 3,
      });
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, before.id)))[0],
      ).toEqual(before);
      expect(
        (
          await db
            .select()
            .from(transactions)
            .where(
              and(eq(transactions.userId, user.id), eq(transactions.date, new Date('2026-09-10'))),
            )
        )[0].amount,
      ).toBe('120.00');
    }));
});
