import { accounts, categories, scheduledTransactions, transactions, userProfiles } from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { ChargeFlowService } from './charge-flow.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';

async function seed(
  db: Parameters<Parameters<typeof withRollback>[0]>[0],
  email = 'charge-flow@test.com',
) {
  const [user] = await db
    .insert(userProfiles)
    .values({ email, name: 'Test', passwordHash: 'hash' })
    .returning();
  const checking = await new AccountService(db).create(user.id, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  await db
    .update(accounts)
    .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
    .where(eq(accounts.id, checking.id));
  return { userId: user.id, checkingId: checking.id };
}

describe('ChargeFlowService', () => {
  const isoDay = (d: Date | string): string =>
    typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

  it('createFixed makes a monthly recurring_bill schedule and materializes it', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule, materialized } = await svc.createFixed(userId, {
        description: 'Contador',
        amount: '200.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 1),
        dueDay: 10,
      });
      expect(schedule.domainType).toBe('recurring_bill');
      expect(schedule.frequency).toBe('monthly');
      expect(schedule.totalOccurrences).toBeNull();
      expect(schedule.dueDay).toBe(10);
      expect(materialized.created).toBeGreaterThan(0);
    });
  });

  it('createFixed com dueDay antes do dia do startDate comeca no mes seguinte', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createFixed(userId, {
        description: 'Internet',
        amount: '120.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 20),
        dueDay: 5,
      });

      const rows = await db
        .select({ date: transactions.date })
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      const days = rows.map((r) => isoDay(r.date));
      expect(days).not.toContain('2026-06-05');
      expect(days).toContain('2026-07-05');
      expect(isoDay(schedule.startDate)).toBe('2026-07-05');
    });
  });

  it('createFixed com dueDay no/depois do dia do startDate mantem o mes corrente', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createFixed(userId, {
        description: 'Academia',
        amount: '80.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 3),
        dueDay: 20,
      });

      const rows = await db
        .select({ date: transactions.date })
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(rows.map((r) => isoDay(r.date))).toContain('2026-06-20');
    });
  });

  // End-to-end: createFixed materializes the charge as a type:'transfer' row
  // (checking → expense, via deriveTransactionType), and MonthSummaryService's
  // chargeExpenses bucket accepts both 'withdrawal' and 'transfer' for RECURRING
  // domain types. Proves the recurring bucket sees a real materialized charge —
  // not just the hand-inserted 'withdrawal' rows in month-summary.service.test.ts.
  it('createFixed materializes a transfer-typed charge that chargeExpenses counts', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createFixed(userId, {
        description: 'Contador',
        amount: '200.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 1),
        dueDay: 10,
      });

      // The materialized occurrences are type:'transfer' (asset checking →
      // expense, via deriveTransactionType) with domainType 'recurring_bill'.
      const occurrences = await db
        .select({ type: transactions.type, domainType: transactions.domainType })
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(occurrences.length).toBeGreaterThan(0);
      expect(occurrences.every((r) => r.type === 'transfer')).toBe(true);
      expect(occurrences.every((r) => r.domainType === 'recurring_bill')).toBe(true);

      const summary = await new MonthSummaryService(db).getSummary(userId, 6, 2026);
      expect(summary.chargeExpenses).toBe(200);
      expect(summary.totalExpenses).toBe(200);
    });
  });

  it('createOneTime makes a once recurring_bill with one occurrence', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createOneTime(userId, {
        description: 'Conserto',
        amount: '150.00',
        sourceAccountId: checkingId,
        date: new Date(2026, 5, 20),
      });
      expect(schedule.frequency).toBe('once');
      expect(schedule.totalOccurrences).toBe(1);

      const occurrences = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(occurrences.length).toBe(1);
      // Without isPaid the materialized occurrence stays unpaid.
      expect(occurrences[0].isPaid).toBe(false);
      expect(occurrences[0].paidFromAccountId).toBeNull();
    });
  });

  it('createOneTime with isPaid marks the materialized occurrence as paid', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createOneTime(userId, {
        description: 'Já paga',
        amount: '75.00',
        sourceAccountId: checkingId,
        date: new Date(2026, 5, 18),
        isPaid: true,
      });

      const occurrences = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(occurrences.length).toBe(1);
      expect(occurrences[0].isPaid).toBe(true);
      expect(occurrences[0].cashAmount).toBe('75.00');
      expect(occurrences[0].settlementSource).toBe('manual');
      expect(occurrences[0].paidFromAccountId).toBe(checkingId);
      expect(occurrences[0].paidAt).not.toBeNull();
    });
  });

  it('createOneTime with isPaid rejects a non-wallet source account (credit_card)', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const [card] = await db
        .insert(accounts)
        .values({ userId, name: 'Card', type: 'credit_card', currency: 'BRL' })
        .returning();
      const svc = new ChargeFlowService(db);

      // The source account is owned but is NOT a checking/savings wallet, so a
      // paid stamp cannot point paidFromAccountId at it.
      await expect(
        svc.createOneTime(userId, {
          description: 'Já paga em cartão',
          amount: '60.00',
          sourceAccountId: card.id,
          date: new Date(2026, 5, 18),
          isPaid: true,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      // No orphan schedule left behind: the non-wallet source must be rejected
      // BEFORE any recurring_bill row is written, so the user owns zero schedules.
      const schedules = await db
        .select({ id: scheduledTransactions.id })
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.userId, userId));
      expect(schedules.length).toBe(0);
      expect(checkingId).toBeDefined();
    });
  });

  it('createOneTime with isPaid rejects a non-wallet source account (expense)', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db);
      const [expense] = await db
        .insert(accounts)
        .values({ userId, name: 'Outra', type: 'expense', currency: 'BRL' })
        .returning();
      const svc = new ChargeFlowService(db);

      await expect(
        svc.createOneTime(userId, {
          description: 'Já paga em despesa',
          amount: '60.00',
          sourceAccountId: expense.id,
          date: new Date(2026, 5, 18),
          isPaid: true,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('list separates fixed and one-time for a month', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      await svc.createFixed(userId, {
        description: 'Internet',
        amount: '150.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 1),
        dueDay: 5,
      });
      await svc.createOneTime(userId, {
        description: 'Conserto',
        amount: '90.00',
        sourceAccountId: checkingId,
        date: new Date(2026, 5, 12),
      });
      const result = await svc.list(userId, 6, 2026);
      expect(result.fixed.map((f) => f.description)).toContain('Internet');
      expect(result.oneTime.map((o) => o.description)).toContain('Conserto');
    });
  });

  it('list uses a UTC month window for one-time charges on the last day', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createOneTime(userId, {
        description: 'Last day',
        amount: '50.00',
        sourceAccountId: checkingId,
        date: new Date(Date.UTC(2026, 5, 30)),
      });

      const june = await svc.list(userId, 6, 2026);
      expect(june.oneTime.map((c) => c.id)).toContain(schedule.id);

      const july = await svc.list(userId, 7, 2026);
      expect(july.oneTime.map((c) => c.id)).not.toContain(schedule.id);
    });
  });

  describe('list — per-month occurrence paid-state', () => {
    it('exposes a non-null transactionId and isPaid:false for an unpaid fixed occurrence in the viewed month', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const svc = new ChargeFlowService(db);
        await svc.createFixed(userId, {
          description: 'Internet',
          amount: '150.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 5,
        });

        const result = await svc.list(userId, 6, 2026);
        const internet = result.fixed.find((f) => f.description === 'Internet');
        expect(internet).toBeDefined();
        expect(internet?.transactionId).not.toBeNull();
        expect(internet?.isPaid).toBe(false);
      });
    });

    it('reflects isPaid:true (same transactionId) after the occurrence is marked paid', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const checking2 = await new AccountService(db).create(userId, {
          name: 'Bank 2',
          type: 'checking',
          currency: 'BRL',
        });
        await db
          .update(accounts)
          .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
          .where(eq(accounts.id, checking2.id));
        const svc = new ChargeFlowService(db);
        await svc.createFixed(userId, {
          description: 'Internet',
          amount: '150.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 5,
        });

        const before = await svc.list(userId, 6, 2026);
        const beforeRow = before.fixed.find((f) => f.description === 'Internet');
        expect(beforeRow?.transactionId).not.toBeNull();
        expect(beforeRow?.isPaid).toBe(false);

        // beforeRow.transactionId is the June occurrence; non-null asserted above.
        const occurrenceId = beforeRow?.transactionId;
        expect(occurrenceId).toBeTruthy();
        await svc.markOccurrenceAsPaid(userId, occurrenceId as string, checking2.id);

        const after = await svc.list(userId, 6, 2026);
        const afterRow = after.fixed.find((f) => f.description === 'Internet');
        expect(afterRow?.isPaid).toBe(true);
        expect(afterRow?.transactionId).toBe(occurrenceId);
      });
    });

    it('returns transactionId:null, isPaid:false for a fixed charge with no occurrence in the queried month', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const svc = new ChargeFlowService(db);
        // Materializes Jun, Jul, Aug 2026 only (endDate caps at Aug 31).
        await svc.createFixed(userId, {
          description: 'Curta duração',
          amount: '50.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 10,
          endDate: new Date(2026, 7, 31),
        });

        // December 2026 is past the endDate → no materialized occurrence.
        const result = await svc.list(userId, 12, 2026);
        const row = result.fixed.find((f) => f.description === 'Curta duração');
        expect(row).toBeUndefined();
      });
    });

    it('exposes transactionId and correct isPaid for a one-time charge in the month', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const svc = new ChargeFlowService(db);
        await svc.createOneTime(userId, {
          description: 'Conserto pago',
          amount: '90.00',
          sourceAccountId: checkingId,
          date: new Date(2026, 5, 12),
          isPaid: true,
        });
        await svc.createOneTime(userId, {
          description: 'Conserto pendente',
          amount: '40.00',
          sourceAccountId: checkingId,
          date: new Date(2026, 5, 13),
        });

        const result = await svc.list(userId, 6, 2026);
        const paid = result.oneTime.find((o) => o.description === 'Conserto pago');
        const pending = result.oneTime.find((o) => o.description === 'Conserto pendente');
        expect(paid?.transactionId).not.toBeNull();
        expect(paid?.isPaid).toBe(true);
        expect(pending?.transactionId).not.toBeNull();
        expect(pending?.isPaid).toBe(false);
      });
    });

    it('returns transactionId:null, isPaid:false for all rows when month/year are omitted', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const svc = new ChargeFlowService(db);
        await svc.createFixed(userId, {
          description: 'Internet',
          amount: '150.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 5,
        });

        const result = await svc.list(userId);
        const internet = result.fixed.find((f) => f.description === 'Internet');
        expect(internet).toBeDefined();
        expect(internet?.transactionId).toBeNull();
        expect(internet?.isPaid).toBe(false);
      });
    });

    it("never leaks another user's occurrence into the first user's list (userId-scoped lookup)", async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db, 'charge-iso-a@test.com');
        const { userId: otherUserId, checkingId: otherCheckingId } = await seed(
          db,
          'charge-iso-b@test.com',
        );
        const svc = new ChargeFlowService(db);

        // Both users have a same-named fixed charge with a June occurrence; the
        // OTHER user pays theirs. User A's list must show their OWN occurrence
        // (unpaid), never the other user's paid row.
        await svc.createFixed(userId, {
          description: 'Internet',
          amount: '150.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 5,
        });
        await svc.createFixed(otherUserId, {
          description: 'Internet',
          amount: '150.00',
          sourceAccountId: otherCheckingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 5,
        });
        const otherList = await svc.list(otherUserId, 6, 2026);
        const otherRow = otherList.fixed.find((f) => f.description === 'Internet');
        expect(otherRow?.transactionId).toBeTruthy();
        await svc.markOccurrenceAsPaid(
          otherUserId,
          otherRow?.transactionId as string,
          otherCheckingId,
        );

        const result = await svc.list(userId, 6, 2026);
        expect(result.fixed.length).toBe(1);
        const own = result.fixed[0];
        expect(own.transactionId).toBeTruthy();
        expect(own.transactionId).not.toBe(otherRow?.transactionId);
        expect(own.isPaid).toBe(false);
      });
    });
  });

  it('deactivate marks the schedule inactive and removes its future materialized rows', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createFixed(userId, {
        description: 'Aluguel',
        amount: '1000.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 1),
        dueDay: 1,
      });

      // Sanity: createFixed materialized future rows.
      const before = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(before.length).toBeGreaterThan(0);

      await svc.deactivate(userId, schedule.id);

      const [row] = await db
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      expect(row.isActive).toBe(false);

      // (a) No non-reversed materialized rows remain for the cancelled charge.
      const after = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(after.length).toBe(0);

      // (b) A future month no longer counts this charge as an expense.
      const summary = await new MonthSummaryService(db).getSummary(userId, 12, 2026);
      expect(summary.chargeExpenses).toBe(0);
    });
  });

  it('deactivate preserves paid occurrences while deleting unpaid ones', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createFixed(userId, {
        description: 'Mensalidade',
        amount: '300.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 1),
        dueDay: 5,
      });

      const occurrences = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(occurrences.length).toBeGreaterThan(1);

      // Mark the earliest occurrence as paid (mirrors createOneTime's paid flip).
      const [paidOccurrence] = [...occurrences].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      );
      await db
        .update(transactions)
        .set({ isPaid: true, paidAt: new Date(), paidFromAccountId: checkingId })
        .where(eq(transactions.id, paidOccurrence.id));

      await svc.deactivate(userId, schedule.id);

      // The paid occurrence is preserved (non-reversed, still paid).
      const [survivor] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, paidOccurrence.id));
      expect(survivor).toBeDefined();
      expect(survivor.isReversed).toBe(false);
      expect(survivor.isPaid).toBe(true);

      // Only the paid row remains; every unpaid future row was deleted.
      const remaining = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe(paidOccurrence.id);

      // Schedule itself is deactivated.
      const [row] = await db
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      expect(row.isActive).toBe(false);
    });
  });

  it('update preserves paid occurrences while rematerializing unpaid ones', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createFixed(userId, {
        description: 'Mensalidade',
        amount: '300.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 1),
        dueDay: 5,
      });

      const occurrences = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );
      expect(occurrences.length).toBeGreaterThan(1);

      const [paidOccurrence] = [...occurrences].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      );
      await db
        .update(transactions)
        .set({ isPaid: true, paidAt: new Date(), paidFromAccountId: checkingId })
        .where(eq(transactions.id, paidOccurrence.id));

      await svc.update(userId, { scheduleId: schedule.id, amount: '350.00', dueDay: 20 });

      // The paid occurrence survived the rematerialize untouched: still present,
      // non-reversed, paid, and keeping its original amount/day (no rewrite of
      // settled history).
      const [survivor] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, paidOccurrence.id));
      expect(survivor).toBeDefined();
      expect(survivor.isReversed).toBe(false);
      expect(survivor.isPaid).toBe(true);
      expect(survivor.amount).toBe('300.00');
      expect(new Date(survivor.date).getUTCDate()).toBe(5);

      // Unpaid rows were rematerialized at the new amount/day; no day-5 unpaid
      // survivors and no duplicate of the paid month.
      const unpaid = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
            eq(transactions.isPaid, false),
          ),
        );
      expect(unpaid.length).toBeGreaterThan(0);
      expect(unpaid.every((r) => r.amount === '350.00')).toBe(true);
      expect(unpaid.every((r) => new Date(r.date).getUTCDate() === 20)).toBe(true);
    });
  });

  it('update changes amount + dueDay without double-counting materialized rows', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createFixed(userId, {
        description: 'Plano de saúde',
        amount: '200.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 1),
        dueDay: 10,
      });

      await svc.update(userId, { scheduleId: schedule.id, amount: '250.00', dueDay: 15 });

      const [row] = await db
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      expect(row.amount).toBe('250.00');
      expect(row.dueDay).toBe(15);

      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );

      // Every materialized row reflects the new amount and the new due day; none
      // retains the old amount/day (no stale survivors → no double counting).
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.amount === '250.00')).toBe(true);
      expect(rows.every((r) => new Date(r.date).getUTCDate() === 15)).toBe(true);
      expect(rows.some((r) => new Date(r.date).getUTCDate() === 10)).toBe(false);

      // No duplicate rows: one occurrence per distinct date.
      const dateKeys = rows.map((r) => new Date(r.date).toISOString().slice(0, 10));
      expect(new Set(dateKeys).size).toBe(rows.length);

      // A future month counts the charge once at the new amount, not twice.
      const summary = await new MonthSummaryService(db).getSummary(userId, 9, 2026);
      expect(summary.chargeExpenses).toBe(250);
    });
  });

  it('createFixed rejects a categoryId belonging to another user', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db, 'charge-flow-cat-a@test.com');
      const { userId: otherUserId } = await seed(db, 'charge-flow-cat-b@test.com');
      const [foreignCategory] = await db
        .insert(categories)
        .values({ userId: otherUserId, name: 'Outra', type: 'expense' })
        .returning();
      const svc = new ChargeFlowService(db);

      await expect(
        svc.createFixed(userId, {
          description: 'Categoria alheia',
          amount: '100.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 10,
          categoryId: foreignCategory.id,
        }),
      ).rejects.toThrow();
    });
  });

  it('update rejects a categoryId belonging to another user', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db, 'charge-flow-upd-a@test.com');
      const { userId: otherUserId } = await seed(db, 'charge-flow-upd-b@test.com');
      const [foreignCategory] = await db
        .insert(categories)
        .values({ userId: otherUserId, name: 'Outra', type: 'expense' })
        .returning();
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createFixed(userId, {
        description: 'Conta minha',
        amount: '100.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 1),
        dueDay: 10,
      });

      await expect(
        svc.update(userId, { scheduleId: schedule.id, categoryId: foreignCategory.id }),
      ).rejects.toThrow();
    });
  });

  it('endDate stops materialization after the end date', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createFixed(userId, {
        description: 'Assinatura temporária',
        amount: '50.00',
        sourceAccountId: checkingId,
        startDate: new Date(2026, 5, 1),
        dueDay: 10,
        // Three occurrences: Jun, Jul, Aug 2026 (endDate caps at Aug 31).
        endDate: new Date(2026, 7, 31),
      });

      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
          ),
        );

      // No row should be dated after the endDate.
      const endDate = new Date(Date.UTC(2026, 7, 31));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => new Date(r.date).getTime() <= endDate.getTime())).toBe(true);
    });
  });

  it('createFixed rejects a source account belonging to another user', async () => {
    await withRollback(async (db) => {
      const { userId } = await seed(db, 'charge-flow-a@test.com');
      const { checkingId: foreignCheckingId } = await seed(db, 'charge-flow-b@test.com');
      const svc = new ChargeFlowService(db);

      await expect(
        svc.createFixed(userId, {
          description: 'Tentativa',
          amount: '100.00',
          sourceAccountId: foreignCheckingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 10,
        }),
      ).rejects.toThrow();
    });
  });

  describe('markOccurrenceAsPaid / markOccurrenceAsUnpaid', () => {
    it('markOccurrenceAsPaid sets isPaid/paidAt and redirects the source leg to the chosen wallet', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const checking2 = await new AccountService(db).create(userId, {
          name: 'Bank 2',
          type: 'checking',
          currency: 'BRL',
        });
        await db
          .update(accounts)
          .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
          .where(eq(accounts.id, checking2.id));
        const svc = new ChargeFlowService(db);
        const { schedule } = await svc.createFixed(userId, {
          description: 'Internet',
          amount: '150.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 10,
        });

        const [occurrence] = await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.scheduledTransactionId, schedule.id),
              eq(transactions.isReversed, false),
            ),
          );
        expect(occurrence.sourceAccountId).toBe(checkingId);

        const updated = await svc.markOccurrenceAsPaid(userId, occurrence.id, checking2.id);

        expect(updated.isPaid).toBe(true);
        expect(updated.paidAt).not.toBeNull();
        expect(updated.sourceAccountId).toBe(checking2.id);
        expect(updated.paidFromAccountId).toBe(checking2.id);
      });
    });

    it('markOccurrenceAsUnpaid clears isPaid/paidAt and restores the source from the schedule', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const checking2 = await new AccountService(db).create(userId, {
          name: 'Bank 2',
          type: 'checking',
          currency: 'BRL',
        });
        await db
          .update(accounts)
          .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
          .where(eq(accounts.id, checking2.id));
        const svc = new ChargeFlowService(db);
        const { schedule } = await svc.createFixed(userId, {
          description: 'Internet',
          amount: '150.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 10,
        });

        const [occurrence] = await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.scheduledTransactionId, schedule.id),
              eq(transactions.isReversed, false),
            ),
          );

        await svc.markOccurrenceAsPaid(userId, occurrence.id, checking2.id);
        const restored = await svc.markOccurrenceAsUnpaid(userId, occurrence.id);

        expect(restored.isPaid).toBe(false);
        expect(restored.paidAt).toBeNull();
        expect(restored.paidFromAccountId).toBeNull();
        expect(restored.sourceAccountId).toBe(checkingId);
      });
    });

    it('markOccurrenceAsPaid rejects a non-recurring_bill transaction', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const checking2 = await new AccountService(db).create(userId, {
          name: 'Bank 2',
          type: 'checking',
          currency: 'BRL',
        });
        await db
          .update(accounts)
          .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
          .where(eq(accounts.id, checking2.id));
        const [loan] = await db
          .insert(accounts)
          .values({ userId, name: 'loan', type: 'loan', currency: 'BRL' })
          .returning();
        const [tx] = await db
          .insert(transactions)
          .values({
            userId,
            sourceAccountId: checkingId,
            destinationAccountId: loan.id,
            amount: '900.00',
            currency: 'BRL',
            type: 'transfer',
            description: 'loan payment',
            date: new Date('2026-06-10'),
            domainType: 'loan_payment',
            isPaid: false,
          })
          .returning();
        const svc = new ChargeFlowService(db);

        await expect(svc.markOccurrenceAsPaid(userId, tx.id, checking2.id)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
      });
    });

    it('markOccurrenceAsPaid rejects a wallet that is not checking/savings (credit_card)', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const [card] = await db
          .insert(accounts)
          .values({ userId, name: 'Card', type: 'credit_card', currency: 'BRL' })
          .returning();
        const svc = new ChargeFlowService(db);
        const { schedule } = await svc.createFixed(userId, {
          description: 'Internet',
          amount: '150.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 10,
        });

        const [occurrence] = await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.scheduledTransactionId, schedule.id),
              eq(transactions.isReversed, false),
            ),
          );

        await expect(
          svc.markOccurrenceAsPaid(userId, occurrence.id, card.id),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      });
    });

    it('markOccurrenceAsPaid refuses a transaction owned by a different user', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db, 'charge-paid-owner@test.com');
        const { userId: otherUserId, checkingId: otherCheckingId } = await seed(
          db,
          'charge-paid-intruder@test.com',
        );
        const svc = new ChargeFlowService(db);

        // The OTHER user's recurring_bill occurrence.
        const { schedule } = await svc.createFixed(otherUserId, {
          description: 'Internet alheia',
          amount: '150.00',
          sourceAccountId: otherCheckingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 10,
        });
        const [foreignOccurrence] = await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.scheduledTransactionId, schedule.id),
              eq(transactions.isReversed, false),
            ),
          );

        // The current user must not be able to settle it. The userId-scoped
        // load finds no row, so the guard reports NOT_FOUND (parity with
        // assertSettleableIncomeTx) — never leaking that the row exists.
        await expect(
          svc.markOccurrenceAsPaid(userId, foreignOccurrence.id, checkingId),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });

        // And it stays unpaid.
        const [after] = await db
          .select()
          .from(transactions)
          .where(eq(transactions.id, foreignOccurrence.id));
        expect(after.isPaid).toBe(false);
      });
    });

    it('markOccurrenceAsPaid rejects an already-paid occurrence', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const checking2 = await new AccountService(db).create(userId, {
          name: 'Bank 2',
          type: 'checking',
          currency: 'BRL',
        });
        await db
          .update(accounts)
          .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
          .where(eq(accounts.id, checking2.id));
        const svc = new ChargeFlowService(db);
        const { schedule } = await svc.createFixed(userId, {
          description: 'Internet',
          amount: '150.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 10,
        });

        const [occurrence] = await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.scheduledTransactionId, schedule.id),
              eq(transactions.isReversed, false),
            ),
          );

        await svc.markOccurrenceAsPaid(userId, occurrence.id, checking2.id);

        // Paying again hits the requireUnpaid && isPaid guard branch.
        await expect(
          svc.markOccurrenceAsPaid(userId, occurrence.id, checking2.id),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      });
    });

    it('markOccurrenceAsUnpaid rejects an already-unpaid occurrence', async () => {
      await withRollback(async (db) => {
        const { userId, checkingId } = await seed(db);
        const svc = new ChargeFlowService(db);
        const { schedule } = await svc.createFixed(userId, {
          description: 'Internet',
          amount: '150.00',
          sourceAccountId: checkingId,
          startDate: new Date(2026, 5, 1),
          dueDay: 10,
        });

        const [occurrence] = await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.scheduledTransactionId, schedule.id),
              eq(transactions.isReversed, false),
            ),
          );

        // Unpaying a never-paid occurrence hits the !requireUnpaid && !isPaid branch.
        await expect(svc.markOccurrenceAsUnpaid(userId, occurrence.id)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
      });
    });
  });

  it('list nao retorna cobranca unica desativada', async () => {
    await withRollback(async (db) => {
      const { userId, checkingId } = await seed(db);
      const svc = new ChargeFlowService(db);
      const { schedule } = await svc.createOneTime(userId, {
        description: 'Compra cancelada',
        amount: '99.00',
        sourceAccountId: checkingId,
        date: new Date(Date.UTC(2026, 5, 20)),
      });

      await svc.deactivate(userId, schedule.id);

      const result = await svc.list(userId, 6, 2026);
      expect(result.oneTime.map((c) => c.id)).not.toContain(schedule.id);
      expect(result.oneTime).toHaveLength(0);
    });
  });
});
