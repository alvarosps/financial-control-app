import { creditCardBills, creditCardConfigs } from '@fc/db';
import { resolveStatementCycle } from '@fc/domain';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { noOpGuard } from '../lib/materialization-guard.ts';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { BalanceProjectionService } from './balance-projection.service.ts';
import { BillService } from './bill.service.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { DailyControlService } from './daily-control.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';
import { ProjectionService } from './projection.service.ts';
import { StatementCycleService } from './statement-cycle.service.ts';

describe('persisted statement cycles across readers', () => {
  it('preserves a confirmed due date when new settings would estimate closing after that date', async () => {
    await withRollback(async (db) => {
      const user = await createTestUser(db);
      const { account: card } = await new CreditCardFlowService(db).createCreditCard(user.id, {
        name: 'Card',
        closingDay: 3,
        dueDay: 15,
      });
      await db.insert(creditCardBills).values({
        creditCardAccountId: card.id,
        month: 9,
        year: 2026,
        totalAmount: '100.00',
        closingDate: '2026-09-03',
        closingDateSource: 'configuration',
        dueDate: '2026-09-15',
        dueDateSource: 'institution',
      });
      await db
        .update(creditCardConfigs)
        .set({ closingDay: 20, dueDay: 25 })
        .where(eq(creditCardConfigs.accountId, card.id));
      const bill = await new BillService(db, noOpGuard).getBill(user.id, card.id, 9, 2026);
      expect(bill).toMatchObject({
        dueDate: '2026-09-15',
        dueDateSource: 'institution',
        closingDate: null,
        closingDateSource: 'unknown',
        confidence: 'unknown',
      });
      expect(
        await new BillService(db, noOpGuard).getBillsDueInMonth(user.id, 9, 2026),
      ).toContainEqual(expect.objectContaining({ cardId: card.id, dueDate: '2026-09-15' }));
    });
  });

  it('rejects a conflicting additional statement and preserves confirmed dates over estimates', async () => {
    await withRollback(async (db) => {
      const user = await createTestUser(db);
      const flow = new CreditCardFlowService(db);
      const { account: parent } = await flow.createCreditCard(user.id, {
        name: 'Parent',
        closingDay: 24,
        dueDay: 8,
      });
      const { account: child } = await flow.createCreditCard(user.id, {
        name: 'Child',
        closingDay: 3,
        dueDay: 15,
        parentAccountId: parent.id,
      });
      const cycles = new StatementCycleService(db);
      const actual = resolveStatementCycle({
        reference: 'closing',
        month: 8,
        year: 2026,
        closingDate: '2026-08-24',
        dueDate: '2026-09-08',
      });
      await cycles.persist(user.id, { cardAccountId: parent.id, month: 8, year: 2026 }, actual);
      await expect(
        cycles.persist(
          user.id,
          { cardAccountId: child.id, month: 8, year: 2026 },
          { ...actual, dueDate: '2026-09-09' },
        ),
      ).rejects.toThrow('statement.cycleConflict');
      await expect(
        cycles.persist(
          user.id,
          { cardAccountId: parent.id, month: 8, year: 2026 },
          resolveStatementCycle({
            reference: 'closing',
            month: 8,
            year: 2026,
            config: { closingDay: 3, dueDay: 15 },
          }),
        ),
      ).resolves.toBeUndefined();
      const bill = await new BillService(db, noOpGuard).getBill(user.id, child.id, 8, 2026);
      expect(bill.dueDate).toBe('2026-09-08');
    });
  });
  it('keeps August competence and September cash dates stable for the parent and additional', async () => {
    await withRollback(async (db) => {
      const user = await createTestUser(db);
      const flow = new CreditCardFlowService(db);
      const expense = await new AccountService(db).create(user.id, {
        name: 'Expense',
        type: 'expense',
        currency: 'BRL',
      });
      const { account: parent } = await flow.createCreditCard(user.id, {
        name: 'Parent',
        closingDay: 24,
        dueDay: 8,
      });
      const { account: child } = await flow.createCreditCard(user.id, {
        name: 'Additional',
        closingDay: 1,
        dueDay: 5,
        parentAccountId: parent.id,
      });
      await flow.addOneTimeExpense(user.id, {
        creditCardAccountId: child.id,
        expenseAccountId: expense.id,
        amount: '100.00',
        description: 'Purchase',
        billingMonth: 8,
        billingYear: 2026,
      });
      await flow.addRefund(user.id, {
        creditCardAccountId: child.id,
        expenseAccountId: expense.id,
        amount: '20.00',
        description: 'Refund',
        billingMonth: 8,
        billingYear: 2026,
      });
      const [bill] = await db
        .insert(creditCardBills)
        .values({
          creditCardAccountId: parent.id,
          month: 8,
          year: 2026,
          totalAmount: '80.00',
          closingDate: '2026-08-24',
          dueDate: '2026-09-08',
          closingDateSource: 'institution',
          dueDateSource: 'institution',
        })
        .returning();
      await db
        .update(creditCardConfigs)
        .set({ closingDay: 3, dueDay: 15 })
        .where(eq(creditCardConfigs.accountId, parent.id));
      const bills = new BillService(db, noOpGuard);
      const childBill = await bills.getBill(user.id, child.id, 8, 2026);
      expect(childBill).toMatchObject({
        billId: bill?.id,
        dueDate: '2026-09-08',
        closingDate: '2026-08-24',
        total: 80,
      });
      const summary = await bills.getBillForMonth(user.id, 8, 2026);
      expect(summary[0]).toMatchObject({
        billId: bill?.id,
        month: 8,
        dueDate: '2026-09-08',
        total: 80,
      });
      const daily = new DailyControlService(db);
      expect((await daily.getDailyControl(user.id, 8, 2026)).summary.totalOut).toBe(0);
      const september = await daily.getDailyControl(user.id, 9, 2026);
      expect(september.days.flatMap((day) => day.items)).toContainEqual(
        expect.objectContaining({
          billId: bill?.id,
          billingMonth: 8,
          billingYear: 2026,
          amount: 80,
          date: '2026-09-08',
          dueDateSource: 'institution',
        }),
      );
      expect(
        (await new MonthSummaryService(db).getSummary(user.id, 8, 2026)).creditCardExpenses,
      ).toBe(80);
      const projection = await new ProjectionService(db).get12MonthProjection(
        user.id,
        new Date(2026, 7, 1),
      );
      expect(projection[0]?.creditCardExpenses).toBe(80);
      const cash = await new BalanceProjectionService(db).getBaselineCores(user.id, {
        horizon: 2,
        asOf: new Date(2026, 7, 1),
      });
      expect(cash.map((month) => month.expenses.creditCard)).toEqual([0, 80]);
      expect((await bills.getBill(user.id, child.id, 9, 2026)).dueDate).toBe('2026-09-15');
    });
  });
});
