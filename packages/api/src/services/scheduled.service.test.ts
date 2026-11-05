import type { DbExecutor } from '@fc/db';
import { accounts, scheduledTransactions, transactions, userProfiles } from '@fc/db';
import { BusinessRuleError } from '@fc/domain';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { ScheduledService } from './scheduled.service.ts';

const TEST_USER = {
  email: 'scheduled-test@example.com',
  name: 'Scheduled Test User',
  passwordHash: 'hashed',
};

async function setupUserAndAccounts(db: DbExecutor) {
  const accountService = new AccountService(db);
  const scheduledService = new ScheduledService(db);

  const [user] = await db.insert(userProfiles).values(TEST_USER).returning();

  const checking = await accountService.create(user.id, {
    name: 'Checking',
    type: 'checking',
    currency: 'BRL',
  });

  const expense = await accountService.create(user.id, {
    name: 'Expenses',
    type: 'expense',
    currency: 'BRL',
  });

  const revenue = await accountService.create(user.id, {
    name: 'Revenue',
    type: 'revenue',
    currency: 'BRL',
  });

  const creditCard = await accountService.create(user.id, {
    name: 'Credit Card',
    type: 'credit_card',
    currency: 'BRL',
  });

  return { scheduledService, userId: user.id, checking, expense, revenue, creditCard };
}

describe('ScheduledService', () => {
  describe('create', () => {
    it('creates a monthly recurring bill', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, expense, creditCard } = await setupUserAndAccounts(db);

        const schedule = await scheduledService.create(userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '150.00',
          description: 'Netflix',
          frequency: 'monthly',
          startDate: new Date('2026-01-15'),
          dueDay: 15,
        });

        expect(schedule.description).toBe('Netflix');
        expect(schedule.frequency).toBe('monthly');
        expect(schedule.amount).toBe('150.00');
        expect(schedule.dueDay).toBe(15);
        expect(schedule.isActive).toBe(true);
        expect(schedule.totalOccurrences).toBeNull();
      });
    });

    it('rejects startingOccurrence != 1 (mid-stream must be expressed by backdating startDate)', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, expense, creditCard } = await setupUserAndAccounts(db);

        await expect(
          scheduledService.create(userId, {
            sourceAccountId: expense.id,
            destinationAccountId: creditCard.id,
            amount: '100.00',
            description: 'Phone purchase',
            frequency: 'monthly',
            startDate: new Date('2026-01-10'),
            totalOccurrences: 10,
            startingOccurrence: 3,
          }),
        ).rejects.toBeInstanceOf(BusinessRuleError);
      });
    });

    it('accepts explicit startingOccurrence = 1', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, expense, creditCard } = await setupUserAndAccounts(db);

        const schedule = await scheduledService.create(userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Phone purchase',
          frequency: 'monthly',
          startDate: new Date('2025-11-10'),
          totalOccurrences: 10,
          startingOccurrence: 1,
        });

        expect(schedule.totalOccurrences).toBe(10);
        expect(schedule.startingOccurrence).toBe(1);
      });
    });

    it('creates a one-time expense (frequency=once, totalOccurrences=1 auto)', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, expense, checking } = await setupUserAndAccounts(db);

        const schedule = await scheduledService.create(userId, {
          sourceAccountId: expense.id,
          destinationAccountId: checking.id,
          amount: '250.00',
          description: 'One-time repair',
          frequency: 'once',
          startDate: new Date('2026-03-20'),
        });

        expect(schedule.frequency).toBe('once');
        expect(schedule.totalOccurrences).toBe(1);
      });
    });

    it('creates income as scheduled deposit (domainType=income_clt)', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, revenue, checking } = await setupUserAndAccounts(db);

        const schedule = await scheduledService.create(userId, {
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '5000.00',
          description: 'Monthly salary',
          frequency: 'monthly',
          startDate: new Date('2026-01-05'),
          dueDay: 5,
          domainType: 'income_clt',
        });

        expect(schedule.domainType).toBe('income_clt');
        expect(schedule.amount).toBe('5000.00');
      });
    });
  });

  describe('listByUser', () => {
    it('lists only active schedules for a user', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, expense, creditCard } = await setupUserAndAccounts(db);

        await scheduledService.create(userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Active bill',
          frequency: 'monthly',
          startDate: new Date('2026-01-01'),
        });

        const toDeactivate = await scheduledService.create(userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '50.00',
          description: 'Inactive bill',
          frequency: 'monthly',
          startDate: new Date('2026-01-01'),
        });

        await scheduledService.deactivate(userId, toDeactivate.id);

        const active = await scheduledService.listByUser(userId);

        expect(active).toHaveLength(1);
        expect(active[0].description).toBe('Active bill');
      });
    });

    it('returns stable pages ordered by creation time and id', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, expense, creditCard } = await setupUserAndAccounts(db);
        const created: Awaited<ReturnType<ScheduledService['create']>>[] = [];

        for (let index = 0; index < 5; index += 1) {
          const schedule = await scheduledService.create(userId, {
            sourceAccountId: expense.id,
            destinationAccountId: creditCard.id,
            amount: '10.00',
            description: `schedule-${index + 1}`,
            frequency: 'monthly',
            startDate: new Date(Date.UTC(2026, 0, index + 1)),
          });
          created.push(schedule);
        }

        for (const [index, schedule] of created.entries()) {
          await db
            .update(scheduledTransactions)
            .set({ createdAt: new Date(Date.UTC(2026, 0, 5 - index)) })
            .where(eq(scheduledTransactions.id, schedule.id));
        }

        const page1 = await scheduledService.listByUser(userId, 1, 2);
        const page2 = await scheduledService.listByUser(userId, 2, 2);
        const page3 = await scheduledService.listByUser(userId, 3, 2);
        const refetchedPage1 = await scheduledService.listByUser(userId, 1, 2);

        const ids = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
        expect(new Set(ids).size).toBe(5);
        expect(page1.items[0].description).toBe('schedule-5');
        expect(page3.items[0].description).toBe('schedule-1');
        expect(refetchedPage1.items.map((item) => item.id)).toEqual(
          page1.items.map((item) => item.id),
        );
      });
    });
  });

  describe('deactivate', () => {
    it('deactivates a schedule', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, expense, creditCard } = await setupUserAndAccounts(db);

        const schedule = await scheduledService.create(userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '75.00',
          description: 'To deactivate',
          frequency: 'monthly',
          startDate: new Date('2026-01-01'),
        });

        const deactivated = await scheduledService.deactivate(userId, schedule.id);

        expect(deactivated.isActive).toBe(false);
      });
    });
  });

  describe('update', () => {
    it('updates description and amount of a schedule', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, expense, creditCard } = await setupUserAndAccounts(db);

        const schedule = await scheduledService.create(userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Old description',
          frequency: 'monthly',
          startDate: new Date('2026-01-01'),
        });

        const updated = await scheduledService.update(userId, schedule.id, {
          description: 'New description',
          amount: '120.00',
        });

        expect(updated.description).toBe('New description');
        expect(updated.amount).toBe('120.00');
      });
    });

    it('syncs unpaid materialized transactions and leaves paid history untouched', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, expense, creditCard } = await setupUserAndAccounts(db);
        const schedule = await scheduledService.create(userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '36.90',
          description: 'fatura abril',
          frequency: 'monthly',
          startDate: new Date('2026-04-01'),
        });
        // one PAID (history) + one UNPAID (current/future), both from this schedule
        await db.insert(transactions).values([
          {
            userId,
            sourceAccountId: expense.id,
            destinationAccountId: creditCard.id,
            amount: '36.90',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'fatura abril',
            date: new Date('2026-05-10'),
            billingMonth: 5,
            billingYear: 2026,
            domainType: 'credit_card_expense',
            scheduledTransactionId: schedule.id,
            isPaid: true,
            paidAt: new Date(),
          },
          {
            userId,
            sourceAccountId: expense.id,
            destinationAccountId: creditCard.id,
            amount: '36.90',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'fatura abril',
            date: new Date('2026-06-10'),
            billingMonth: 6,
            billingYear: 2026,
            domainType: 'credit_card_expense',
            scheduledTransactionId: schedule.id,
            isPaid: false,
          },
        ]);

        await scheduledService.update(userId, schedule.id, {
          description: 'Estacionamento Dolphin Mini',
          amount: '22.00',
        });

        const rows = await db
          .select()
          .from(transactions)
          .where(eq(transactions.scheduledTransactionId, schedule.id));
        const paid = rows.find((r) => r.isPaid);
        const unpaid = rows.find((r) => !r.isPaid);
        // current/future row reflects the edit immediately (no stale fatura row)
        expect(unpaid?.description).toBe('Estacionamento Dolphin Mini');
        expect(unpaid?.amount).toBe('22.00');
        // paid history is settled — left untouched
        expect(paid?.description).toBe('fatura abril');
        expect(paid?.amount).toBe('36.90');
      });
    });
  });

  describe('deleteSchedule', () => {
    it('deactivates the schedule and purges unpaid rows, keeping paid history', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId, expense, creditCard } = await setupUserAndAccounts(db);
        const schedule = await scheduledService.create(userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Parcela',
          frequency: 'monthly',
          startDate: new Date('2026-04-01'),
          totalOccurrences: 3,
          startingOccurrence: 1,
        });
        // one PAID (history) + one UNPAID (current/future), both linked to the schedule
        await db.insert(transactions).values([
          {
            userId,
            sourceAccountId: expense.id,
            destinationAccountId: creditCard.id,
            amount: '100.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Parcela',
            date: new Date('2026-04-10'),
            billingMonth: 4,
            billingYear: 2026,
            installmentNumber: 1,
            totalInstallments: 3,
            domainType: 'credit_card_installment',
            scheduledTransactionId: schedule.id,
            isPaid: true,
            paidAt: new Date(),
          },
          {
            userId,
            sourceAccountId: expense.id,
            destinationAccountId: creditCard.id,
            amount: '100.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Parcela',
            date: new Date('2026-06-10'),
            billingMonth: 6,
            billingYear: 2026,
            installmentNumber: 3,
            totalInstallments: 3,
            domainType: 'credit_card_installment',
            scheduledTransactionId: schedule.id,
            isPaid: false,
          },
        ]);

        const result = await scheduledService.deleteSchedule(userId, schedule.id);
        expect(result.deletedCount).toBe(1); // only the unpaid row purged

        const remaining = await db
          .select()
          .from(transactions)
          .where(eq(transactions.scheduledTransactionId, schedule.id));
        expect(remaining).toHaveLength(1);
        expect(remaining[0].isPaid).toBe(true); // paid history preserved

        const [sched] = await db
          .select()
          .from(scheduledTransactions)
          .where(eq(scheduledTransactions.id, schedule.id));
        expect(sched.isActive).toBe(false);
      });
    });

    it('throws NotFound for a missing schedule', async () => {
      await withRollback(async (db) => {
        const { scheduledService, userId } = await setupUserAndAccounts(db);
        await expect(
          scheduledService.deleteSchedule(userId, '00000000-0000-0000-0000-000000000000'),
        ).rejects.toThrow();
      });
    });
  });

  it('rejects schedule mutations for an archived credit card', async () => {
    await withRollback(async (db) => {
      const { scheduledService, userId, expense, creditCard } = await setupUserAndAccounts(db);
      const schedule = await scheduledService.create(userId, {
        sourceAccountId: expense.id,
        destinationAccountId: creditCard.id,
        amount: '10.00',
        description: 'Old installment',
        frequency: 'once',
        startDate: new Date('2026-01-01'),
        domainType: 'credit_card_expense',
      });
      await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, creditCard.id));

      await expect(
        scheduledService.update(userId, schedule.id, { description: 'Changed' }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'CARD_ARCHIVED' });
      await expect(scheduledService.deleteSchedule(userId, schedule.id)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'CARD_ARCHIVED',
      });
    });
  });
});
