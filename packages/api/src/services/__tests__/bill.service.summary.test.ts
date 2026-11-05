import { transactions, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../../test/with-rollback.ts';
import { AccountService } from '../account.service.ts';
import { BillService } from '../bill.service.ts';
import { MaterializationGuard } from '../materialization-guard.service.ts';

function thisMonth(): { month: number; year: number } {
  const d = new Date();
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}

describe('BillService.getBillSummary', () => {
  it('returns the stored account color for each card', async () => {
    await withRollback(async (db) => {
      const accountService = new AccountService(db);
      const billService = new BillService(db, new MaterializationGuard(db));

      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'summary-color@test.com', name: 'Test', passwordHash: 'hash' })
        .returning();
      const userId = user.id;

      const expense = await accountService.create(userId, {
        name: 'Food',
        type: 'expense',
        currency: 'BRL',
      });
      const card = await accountService.create(userId, {
        name: 'C6',
        type: 'credit_card',
        currency: 'BRL',
        color: '#ff8800',
      });

      const m = thisMonth();
      await db.insert(transactions).values({
        userId,
        sourceAccountId: expense.id,
        destinationAccountId: card.id,
        amount: '100.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'x',
        date: new Date(m.year, m.month - 1, 5),
        billingMonth: m.month,
        billingYear: m.year,
        domainType: 'credit_card_expense',
        isPaid: false,
      });

      const summary = await billService.getBillSummary(userId);
      const entry = summary.find((c) => c.cardId === card.id);
      expect(entry?.color).toBe('#ff8800');
      expect(entry).toMatchObject({
        currentBill: { total: 100, unpaidTotal: 100 },
        canArchive: false,
        archiveBlockedReason: 'CURRENT_BILL',
      });
    });
  });

  it('reports archive eligibility for empty and future-committed cards', async () => {
    await withRollback(async (db) => {
      const accountService = new AccountService(db);
      const billService = new BillService(db, new MaterializationGuard(db));

      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'summary-archive@test.com', name: 'Test', passwordHash: 'hash' })
        .returning();
      const expense = await accountService.create(user.id, {
        name: 'Food',
        type: 'expense',
        currency: 'BRL',
      });
      const emptyCard = await accountService.create(user.id, {
        name: 'Empty',
        type: 'credit_card',
        currency: 'BRL',
      });
      const futureCard = await accountService.create(user.id, {
        name: 'Future',
        type: 'credit_card',
        currency: 'BRL',
      });
      const current = thisMonth();
      const next =
        current.month === 12
          ? { month: 1, year: current.year + 1 }
          : { month: current.month + 1, year: current.year };

      await db.insert(transactions).values({
        userId: user.id,
        sourceAccountId: expense.id,
        destinationAccountId: futureCard.id,
        amount: '50.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Future',
        date: new Date(next.year, next.month - 1, 5),
        billingMonth: next.month,
        billingYear: next.year,
        domainType: 'credit_card_expense',
        isPaid: false,
      });

      const summary = await billService.getBillSummary(user.id);
      expect(summary.find((card) => card.cardId === emptyCard.id)).toMatchObject({
        currentBill: { total: 0, unpaidTotal: 0 },
        canArchive: true,
        archiveBlockedReason: null,
      });
      expect(summary.find((card) => card.cardId === futureCard.id)).toMatchObject({
        canArchive: false,
        archiveBlockedReason: 'FUTURE_COMMITMENTS',
      });
    });
  });
});
