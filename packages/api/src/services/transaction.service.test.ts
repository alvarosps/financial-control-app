import type { DbExecutor } from '@fc/db';
import { accounts, categories, scheduledTransactions, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createCardWriteContext } from '../lib/card-write-context.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { TransactionService } from './transaction.service.ts';

const TEST_USER = {
  email: 'tx-test@example.com',
  name: 'TX Test User',
  passwordHash: 'hashed',
};

function createCardTransaction(
  transactionService: TransactionService,
  userId: string,
  input: Parameters<TransactionService['create']>[1],
) {
  return transactionService.createWithinCardFlow(createCardWriteContext(userId), userId, input);
}

async function setupUserAndAccounts(db: DbExecutor) {
  const accountService = new AccountService(db);
  const transactionService = new TransactionService(db);

  const [user] = await db.insert(userProfiles).values(TEST_USER).returning();

  const checking = await accountService.create(user.id, {
    name: 'Checking',
    type: 'checking',
    currency: 'BRL',
  });

  const creditCard = await accountService.create(user.id, {
    name: 'Credit Card',
    type: 'credit_card',
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

  return {
    accountService,
    transactionService,
    userId: user.id,
    checking,
    creditCard,
    expense,
    revenue,
  };
}

describe('TransactionService', () => {
  describe('create — balance trigger invariant', () => {
    it('leaves currentBalance equal to the canonical recompute right after create (trigger covers INSERT)', async () => {
      await withRollback(async (db) => {
        const { accountService, transactionService, userId, checking, creditCard } =
          await setupUserAndAccounts(db);

        await createCardTransaction(transactionService, userId, {
          sourceAccountId: checking.id,
          destinationAccountId: creditCard.id,
          amount: '250.00',
          description: 'Mercado',
          date: new Date(2026, 5, 10),
        });

        const [src] = await db
          .select({ balance: accounts.currentBalance })
          .from(accounts)
          .where(eq(accounts.id, checking.id));
        const canonical = await accountService.recalculateBalance(checking.id);
        expect(src.balance).toBe(canonical);

        const [dst] = await db
          .select({ balance: accounts.currentBalance })
          .from(accounts)
          .where(eq(accounts.id, creditCard.id));
        const canonicalDst = await accountService.recalculateBalance(creditCard.id);
        expect(dst.balance).toBe(canonicalDst);
      });
    });
  });

  describe('create', () => {
    it('creates a withdrawal (expense → credit_card)', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, expense, creditCard } = await setupUserAndAccounts(db);

        const tx = await createCardTransaction(transactionService, userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Grocery shopping',
          date: new Date('2026-03-15'),
        });

        expect(tx.type).toBe('withdrawal');
        expect(tx.amount).toBe('100.00');
        expect(tx.description).toBe('Grocery shopping');
      });
    });

    it('creates a deposit (revenue → checking)', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, revenue, checking } = await setupUserAndAccounts(db);

        const tx = await transactionService.create(userId, {
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '5000.00',
          description: 'Salary',
          date: new Date('2026-03-01'),
        });

        expect(tx.type).toBe('deposit');
      });
    });

    it('creates a transfer (checking → credit_card)', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, checking, creditCard } = await setupUserAndAccounts(db);

        const tx = await createCardTransaction(transactionService, userId, {
          sourceAccountId: checking.id,
          destinationAccountId: creditCard.id,
          amount: '500.00',
          description: 'Credit card bill payment',
          date: new Date('2026-03-10'),
        });

        expect(tx.type).toBe('transfer');
      });
    });

    it('updates account balances after transaction', async () => {
      await withRollback(async (db) => {
        const { accountService, transactionService, userId, revenue, checking } =
          await setupUserAndAccounts(db);

        await transactionService.create(userId, {
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '8000.00',
          description: 'Salary',
          date: new Date('2026-03-01'),
        });

        const balance = await accountService.recalculateBalance(checking.id);

        expect(balance).toBe('8000.00');
      });
    });

    it('rejects credit_card_expense without billingMonth/billingYear (BAD_REQUEST)', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, expense, creditCard } = await setupUserAndAccounts(db);

        await expect(
          createCardTransaction(transactionService, userId, {
            sourceAccountId: expense.id,
            destinationAccountId: creditCard.id,
            amount: '50.00',
            description: 'Card expense missing billing',
            date: new Date('2026-06-03'),
            domainType: 'credit_card_expense',
          }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      });
    });

    it('accepts credit_card_expense with both billingMonth and billingYear', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, expense, creditCard } = await setupUserAndAccounts(db);

        const tx = await createCardTransaction(transactionService, userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '75.00',
          description: 'Card expense with billing',
          date: new Date('2026-06-03'),
          domainType: 'credit_card_expense',
          billingMonth: 6,
          billingYear: 2026,
        });

        expect(tx.billingMonth).toBe(6);
        expect(tx.billingYear).toBe(2026);
      });
    });

    it('rejects creating transaction on accounts owned by another user', async () => {
      await withRollback(async (db) => {
        const { accountService, transactionService, userId, expense } =
          await setupUserAndAccounts(db);

        const [otherUser] = await db
          .insert(userProfiles)
          .values({
            email: 'other@test.com',
            name: 'Other',
            passwordHash: 'hash',
          })
          .returning();

        const otherAccount = await accountService.create(otherUser.id, {
          name: 'Other Bank',
          type: 'checking',
          currency: 'BRL',
        });

        await expect(
          transactionService.create(userId, {
            sourceAccountId: expense.id,
            destinationAccountId: otherAccount.id,
            amount: '100.00',
            description: 'Hack attempt',
            date: new Date(2026, 2, 15),
          }),
        ).rejects.toThrow();
      });
    });
  });

  describe('reverse', () => {
    it('reverses a transaction', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, revenue, checking } = await setupUserAndAccounts(db);

        const tx = await transactionService.create(userId, {
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '1000.00',
          description: 'Test deposit',
          date: new Date('2026-03-01'),
        });

        const reversal = await transactionService.reverse(userId, tx.id);

        const original = await transactionService.getById(userId, tx.id);

        expect(original.isReversed).toBe(true);
        expect(original.reversedByTransactionId).toBe(reversal.id);
        expect(reversal.reversesTransactionId).toBe(tx.id);
        expect(reversal.sourceAccountId).toBe(tx.destinationAccountId);
        expect(reversal.destinationAccountId).toBe(tx.sourceAccountId);
      });
    });

    it('rejects reversing an already reversed transaction', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, revenue, checking } = await setupUserAndAccounts(db);

        const tx = await transactionService.create(userId, {
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '100.00',
          description: 'To reverse twice',
          date: new Date(2026, 2, 5),
        });

        await transactionService.reverse(userId, tx.id);

        await expect(transactionService.reverse(userId, tx.id)).rejects.toThrow('already reversed');
      });
    });
  });

  describe('listByPeriod', () => {
    it('lists transactions for the correct period only', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, revenue, checking } = await setupUserAndAccounts(db);

        await transactionService.create(userId, {
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '1000.00',
          description: 'March transaction',
          date: new Date('2026-03-15'),
        });

        await transactionService.create(userId, {
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '2000.00',
          description: 'April transaction',
          date: new Date('2026-04-15'),
        });

        const marchTxs = await transactionService.listByPeriod(userId, { month: 3, year: 2026 });

        expect(marchTxs).toHaveLength(1);
        expect(marchTxs[0].description).toBe('March transaction');
      });
    });

    it('includes UTC-midnight rows on the first and last month days only', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, revenue, checking } = await setupUserAndAccounts(db);
        const mk = (date: Date, description: string) =>
          transactionService.create(userId, {
            sourceAccountId: revenue.id,
            destinationAccountId: checking.id,
            amount: '10.00',
            description,
            date,
          });

        await mk(new Date(Date.UTC(2026, 4, 31)), 'may-31');
        await mk(new Date(Date.UTC(2026, 5, 1)), 'jun-01');
        await mk(new Date(Date.UTC(2026, 5, 30)), 'jun-30');
        await mk(new Date(Date.UTC(2026, 6, 1)), 'jul-01');

        const rows = await transactionService.listByPeriod(userId, { month: 6, year: 2026 });
        const descriptions = rows.map((r) => r.description).sort();
        expect(descriptions).toEqual(['jun-01', 'jun-30']);
      });
    });

    it('returns stable pages ordered by newest transaction first', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, revenue, checking } = await setupUserAndAccounts(db);
        const dates = [10, 15, 15, 15, 20];

        for (const [index, day] of dates.entries()) {
          await transactionService.create(userId, {
            sourceAccountId: revenue.id,
            destinationAccountId: checking.id,
            amount: '10.00',
            description: `tx-${index + 1}`,
            date: new Date(Date.UTC(2026, 5, day)),
          });
        }

        const page1 = await transactionService.listByPeriod(userId, {
          month: 6,
          year: 2026,
          page: 1,
          pageSize: 2,
        });
        const page2 = await transactionService.listByPeriod(userId, {
          month: 6,
          year: 2026,
          page: 2,
          pageSize: 2,
        });
        const page3 = await transactionService.listByPeriod(userId, {
          month: 6,
          year: 2026,
          page: 3,
          pageSize: 2,
        });
        const refetchedPage1 = await transactionService.listByPeriod(userId, {
          month: 6,
          year: 2026,
          page: 1,
          pageSize: 2,
        });

        const ids = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
        expect(new Set(ids).size).toBe(5);
        expect(page1.items[0].date.toISOString().slice(0, 10)).toBe('2026-06-20');
        expect(page3.items[0].date.toISOString().slice(0, 10)).toBe('2026-06-10');
        expect(refetchedPage1.items.map((item) => item.id)).toEqual(
          page1.items.map((item) => item.id),
        );
      });
    });
  });

  describe('double-entry balance invariant', () => {
    it('sum of all account balances equals 0 after random transactions', async () => {
      await withRollback(async (db) => {
        const {
          accountService,
          transactionService,
          userId,
          checking,
          creditCard,
          expense,
          revenue,
        } = await setupUserAndAccounts(db);

        const savings = await accountService.create(userId, {
          name: 'Savings',
          type: 'savings',
          currency: 'BRL',
        });

        const transactions2 = [
          { src: revenue.id, dest: checking.id, amount: '5000.00', desc: 'Salary' },
          { src: revenue.id, dest: checking.id, amount: '1500.00', desc: 'Freelance' },
          { src: revenue.id, dest: savings.id, amount: '2000.00', desc: 'Bonus' },
          { src: expense.id, dest: creditCard.id, amount: '300.00', desc: 'Groceries' },
          { src: expense.id, dest: creditCard.id, amount: '150.00', desc: 'Restaurant' },
          { src: expense.id, dest: creditCard.id, amount: '80.00', desc: 'Transport' },
          { src: checking.id, dest: savings.id, amount: '1000.00', desc: 'Savings transfer' },
          { src: checking.id, dest: creditCard.id, amount: '430.00', desc: 'Bill payment' },
          { src: savings.id, dest: checking.id, amount: '500.00', desc: 'Emergency withdrawal' },
          { src: expense.id, dest: creditCard.id, amount: '200.00', desc: 'Online shopping' },
        ];

        for (const t of transactions2) {
          const input = {
            sourceAccountId: t.src,
            destinationAccountId: t.dest,
            amount: t.amount,
            description: t.desc,
            date: new Date('2026-03-15'),
          };
          if (t.src === creditCard.id || t.dest === creditCard.id) {
            await createCardTransaction(transactionService, userId, input);
          } else {
            await transactionService.create(userId, input);
          }
        }

        const allAccounts = [checking, creditCard, expense, revenue, savings];
        const balances = await Promise.all(
          allAccounts.map((acc) => accountService.recalculateBalance(acc.id)),
        );

        const total = balances.reduce((sum, b) => sum + Number(b), 0);

        expect(Math.abs(total)).toBeLessThanOrEqual(0.01);
      });
    });
  });

  describe('update', () => {
    it('updates description, amount, and date of a one-time expense', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, expense, creditCard } = await setupUserAndAccounts(db);
        const tx = await createCardTransaction(transactionService, userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Old',
          date: new Date('2026-06-05'),
          domainType: 'credit_card_expense',
          billingMonth: 6,
          billingYear: 2026,
        });

        const updated = await transactionService.update(userId, tx.id, {
          description: 'New',
          amount: '150.00',
          date: new Date('2026-06-10'),
        });

        expect(updated.description).toBe('New');
        expect(updated.amount).toBe('150.00');
      });
    });

    it('sets and clears the categoryId of a one-time expense', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, expense, creditCard } = await setupUserAndAccounts(db);
        const [category] = await db
          .insert(categories)
          .values({ userId, name: 'Food', type: 'expense' })
          .returning();
        const tx = await createCardTransaction(transactionService, userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Categorized',
          date: new Date('2026-06-05'),
          domainType: 'credit_card_expense',
          billingMonth: 6,
          billingYear: 2026,
        });

        const withCategory = await transactionService.update(userId, tx.id, {
          categoryId: category.id,
        });
        expect(withCategory.categoryId).toBe(category.id);
        expect(withCategory.classificationSource).toBe('manual');
        expect(withCategory.classificationReviewedAt).not.toBeNull();

        const cleared = await transactionService.update(userId, tx.id, { categoryId: null });
        expect(cleared.categoryId).toBe(null);
        expect(cleared.classificationSource).toBe('manual');
        expect(cleared.classificationRuleId).toBeNull();
      });
    });

    it('updates description and amount of a refund and keeps its domainType', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, expense, creditCard } = await setupUserAndAccounts(db);
        const refund = await createCardTransaction(transactionService, userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '50.00',
          description: 'Refund',
          date: new Date('2026-06-05'),
          domainType: 'credit_card_refund',
          billingMonth: 6,
          billingYear: 2026,
        });

        const updated = await transactionService.update(userId, refund.id, {
          description: 'Refund fixed',
          amount: '75.00',
        });

        expect(updated.amount).toBe('75.00');
        expect(updated.domainType).toBe('credit_card_refund');
      });
    });

    it('rejects changing the amount of a PAID expense (description still allowed)', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, expense, creditCard } = await setupUserAndAccounts(db);
        const tx = await createCardTransaction(transactionService, userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Paid expense',
          date: new Date('2026-06-05'),
          domainType: 'credit_card_expense',
          billingMonth: 6,
          billingYear: 2026,
        });
        await db.update(transactions).set({ isPaid: true }).where(eq(transactions.id, tx.id));

        await expect(
          transactionService.update(userId, tx.id, { amount: '120.00' }),
        ).rejects.toThrow();

        const renamed = await transactionService.update(userId, tx.id, { description: 'Renamed' });
        expect(renamed.description).toBe('Renamed');
      });
    });

    it('rejects editing a non-expense/refund transaction', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, checking, creditCard } = await setupUserAndAccounts(db);
        // checking → credit_card is a transfer (no credit-card domainType).
        const transfer = await createCardTransaction(transactionService, userId, {
          sourceAccountId: checking.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Transfer',
          date: new Date('2026-06-05'),
        });

        await expect(
          transactionService.update(userId, transfer.id, { description: 'x' }),
        ).rejects.toThrow();
      });
    });

    it('rejects editing a schedule-backed transaction', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, expense, creditCard } = await setupUserAndAccounts(db);
        const [sched] = await db
          .insert(scheduledTransactions)
          .values({
            userId,
            sourceAccountId: expense.id,
            destinationAccountId: creditCard.id,
            amount: '100.00',
            currency: 'BRL',
            description: 'Monthly',
            frequency: 'monthly',
            startDate: new Date('2026-06-01'),
            domainType: 'credit_card_expense',
          })
          .returning();
        const [row] = await db
          .insert(transactions)
          .values({
            userId,
            sourceAccountId: expense.id,
            destinationAccountId: creditCard.id,
            amount: '100.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Monthly',
            date: new Date('2026-06-05'),
            billingMonth: 6,
            billingYear: 2026,
            domainType: 'credit_card_expense',
            scheduledTransactionId: sched.id,
          })
          .returning();

        await expect(
          transactionService.update(userId, row.id, { amount: '120.00' }),
        ).rejects.toThrow();
      });
    });

    it('does not allow another user to edit the row', async () => {
      await withRollback(async (db) => {
        const { transactionService, userId, expense, creditCard } = await setupUserAndAccounts(db);
        const tx = await createCardTransaction(transactionService, userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '100.00',
          description: 'Mine',
          date: new Date('2026-06-05'),
          domainType: 'credit_card_expense',
          billingMonth: 6,
          billingYear: 2026,
        });
        const [other] = await db
          .insert(userProfiles)
          .values({ email: 'tx-other@example.com', name: 'Other', passwordHash: 'h' })
          .returning();

        await expect(
          transactionService.update(other.id, tx.id, { description: 'hack' }),
        ).rejects.toThrow();
      });
    });
  });

  it('rejects creating a refund on an archived credit card', async () => {
    await withRollback(async (db) => {
      const { transactionService, userId, expense, creditCard } = await setupUserAndAccounts(db);
      await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, creditCard.id));

      await expect(
        createCardTransaction(transactionService, userId, {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '25.00',
          description: 'Refund',
          date: new Date('2026-06-05'),
          domainType: 'credit_card_refund',
          billingMonth: 6,
          billingYear: 2026,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'CARD_ARCHIVED' });
    });
  });
});
