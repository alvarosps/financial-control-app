import type { DbExecutor } from '@fc/db';
import { categories, transactions, userProfiles } from '@fc/db';
import { Money } from '@fc/domain';
import { describe, expect, it } from 'vitest';
import { createCardWriteContext } from '../lib/card-write-context.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { ChargeFlowService } from './charge-flow.service.ts';
import { LoanFlowService } from './loan-flow.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';
import { getCreditCardSpending } from './monthly-spending/credit-cards.ts';
import { MonthlySpendingService } from './monthly-spending.service.ts';
import { ScheduledService } from './scheduled.service.ts';
import { TransactionService } from './transaction.service.ts';

function createTransaction(
  transactionService: TransactionService,
  userId: string,
  input: Parameters<TransactionService['create']>[1],
) {
  if (input.domainType?.startsWith('credit_card_')) {
    return transactionService.createWithinCardFlow(createCardWriteContext(userId), userId, input);
  }

  return transactionService.create(userId, input);
}

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const txService = new TransactionService(db);
  const loanFlowService = new LoanFlowService(db);
  const scheduledService = new ScheduledService(db);
  const service = new MonthlySpendingService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'monthly-spending@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();
  const userId = user.id;

  const expense = await accountService.create(userId, {
    name: 'Expenses',
    type: 'expense',
    currency: 'BRL',
  });

  const cc = await accountService.create(userId, {
    name: 'Nubank',
    type: 'credit_card',
    currency: 'BRL',
    color: '#8B5CF6',
  });

  const checking = await accountService.create(userId, {
    name: 'Checking',
    type: 'checking',
    currency: 'BRL',
  });

  const [cat] = await db
    .insert(categories)
    .values({ userId, name: 'Shopping', type: 'expense' })
    .returning();

  return {
    txService,
    loanFlowService,
    scheduledService,
    service,
    userId,
    expenseId: expense.id,
    creditCardId: cc.id,
    checkingId: checking.id,
    categoryId: cat.id,
  };
}

describe('MonthlySpendingService — getCreditCardSpending', () => {
  it('includes 1st installment credit card purchases for the billing month', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, creditCardId, categoryId } = await seed(db);
      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '500.00',
        description: 'TV Samsung',
        date: new Date(2026, 2, 5),
        billingMonth: 3,
        billingYear: 2026,
        installmentNumber: 1,
        totalInstallments: 10,
        domainType: 'credit_card_installment',
        categoryId,
      });

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.creditCards).toHaveLength(1);
      expect(result.creditCards[0].cardName).toBe('Nubank');
      expect(result.creditCards[0].total).toBe('500.00');
      expect(result.creditCards[0].items).toHaveLength(1);
      expect(result.creditCards[0].items[0].description).toBe('TV Samsung');
      expect(result.creditCards[0].items[0].amount).toBe('500.00');
      expect(result.creditCards[0].items[0].installmentNumber).toBe(1);
      expect(result.creditCards[0].items[0].totalInstallments).toBe(10);
      expect(result.creditCards[0].items[0].categoryName).toBe('Shopping');
    });
  });

  it('excludes 2nd+ installments from monthly spending', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, creditCardId } = await seed(db);
      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '500.00',
        description: 'TV Samsung',
        date: new Date(2026, 2, 5),
        billingMonth: 3,
        billingYear: 2026,
        installmentNumber: 1,
        totalInstallments: 10,
        domainType: 'credit_card_installment',
      });

      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '500.00',
        description: 'TV Samsung',
        date: new Date(2026, 3, 5),
        billingMonth: 4,
        billingYear: 2026,
        installmentNumber: 2,
        totalInstallments: 10,
        domainType: 'credit_card_installment',
      });

      const result = await service.getMonthlySpending(userId, 4, 2026);

      expect(result.creditCards).toHaveLength(0);
    });
  });

  it('includes one-time credit card purchases (no installments)', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, creditCardId } = await seed(db);
      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '150.00',
        description: 'Groceries',
        date: new Date(2026, 2, 10),
        billingMonth: 3,
        billingYear: 2026,
        domainType: 'credit_card_installment',
      });

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.creditCards).toHaveLength(1);
      expect(result.creditCards[0].total).toBe('150.00');
      expect(result.creditCards[0].items[0].installmentNumber).toBeNull();
      expect(result.creditCards[0].items[0].totalInstallments).toBeNull();
    });
  });

  it('excludes fixed charges from credit cards section', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, creditCardId } = await seed(db);
      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '150.00',
        description: 'Groceries',
        date: new Date(2026, 2, 10),
        billingMonth: 3,
        billingYear: 2026,
        domainType: 'credit_card_installment',
      });

      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '55.00',
        description: 'Netflix',
        date: new Date(2026, 2, 15),
        billingMonth: 3,
        billingYear: 2026,
        domainType: 'credit_card_fixed_charge',
      });

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.creditCards).toHaveLength(1);
      expect(result.creditCards[0].total).toBe('150.00');
      expect(result.creditCards[0].items).toHaveLength(1);
      expect(result.creditCards[0].items[0].description).toBe('Groceries');
    });
  });

  it('excludes reversed transactions', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, creditCardId } = await seed(db);
      const tx = await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '200.00',
        description: 'Cancelled purchase',
        date: new Date(2026, 2, 5),
        billingMonth: 3,
        billingYear: 2026,
        installmentNumber: 1,
        totalInstallments: 3,
        domainType: 'credit_card_installment',
      });

      await txService.reverse(userId, tx.id);

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.creditCards).toHaveLength(0);
    });
  });

  it('groups an additional card under its parent (one group, summed)', async () => {
    await withRollback(async (db) => {
      const accountService = new AccountService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'ms-consolidate@test.com', name: 'T', passwordHash: 'h' })
        .returning();
      const expense = await accountService.create(user.id, {
        name: 'Food',
        type: 'expense',
        currency: 'BRL',
      });
      const parent = await accountService.create(user.id, {
        name: 'Azul',
        type: 'credit_card',
        currency: 'BRL',
      });
      const child = await accountService.create(user.id, {
        name: 'Azul Camila',
        type: 'credit_card',
        currency: 'BRL',
        parentAccountId: parent.id,
      });

      const M = 6,
        Y = 2026;
      await db.insert(transactions).values([
        {
          userId: user.id,
          sourceAccountId: expense.id,
          destinationAccountId: parent.id,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'p',
          date: new Date(Y, M - 1, 5),
          billingMonth: M,
          billingYear: Y,
          installmentNumber: null,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
        {
          userId: user.id,
          sourceAccountId: expense.id,
          destinationAccountId: child.id,
          amount: '40.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'c',
          date: new Date(Y, M - 1, 6),
          billingMonth: M,
          billingYear: Y,
          installmentNumber: null,
          domainType: 'credit_card_expense',
          isPaid: false,
        },
      ]);

      const groups = await getCreditCardSpending(db, user.id, M, Y);
      expect(groups).toHaveLength(1);
      expect(groups[0].cardId).toBe(parent.id);
      expect(groups[0].total).toBe('140.00');
      expect(groups[0].items).toHaveLength(2);
    });
  });
});

describe('MonthlySpendingService — loan spending', () => {
  it('includes loans where 1st installment falls in requested month', async () => {
    await withRollback(async (db) => {
      const { loanFlowService, service, userId, checkingId } = await seed(db);
      const { account } = await loanFlowService.createLoan(userId, {
        name: 'Itaú Consignado',
        loanCategory: 'bank',
        loanType: 'consignado',
        monthlyPayment: '1500.00',
        totalInstallments: 48,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 3, 10),
        checkingAccountId: checkingId,
        monthlyInterestRate: '0.01990000',
        originalAmount: '60000.00',
        annualInterestRate: '0.26820000',
      });

      const result = await service.getMonthlySpending(userId, 4, 2026);

      expect(result.loans).toHaveLength(1);
      expect(result.loans[0].name).toBe('Itaú Consignado');
      expect(result.loans[0].installmentNumber).toBe(1);
      expect(result.loans[0].totalInstallments).toBe(48);
      expect(result.loans[0].monthlyPayment).toBe('1500.00');
      expect(result.loans[0].accountId).toBe(account.id);
    });
  });

  it('excludes loans where 1st installment is in a different month', async () => {
    await withRollback(async (db) => {
      const { loanFlowService, service, userId, checkingId } = await seed(db);
      await loanFlowService.createLoan(userId, {
        name: 'Itaú Consignado',
        loanCategory: 'bank',
        loanType: 'consignado',
        monthlyPayment: '1500.00',
        totalInstallments: 48,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 3, 10),
        checkingAccountId: checkingId,
        monthlyInterestRate: '0.01990000',
      });

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.loans).toHaveLength(0);
    });
  });
});

describe('MonthlySpendingService — fixed expenses', () => {
  it('includes credit card fixed charges for the billing month', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, creditCardId, categoryId } = await seed(db);
      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '55.00',
        description: 'Netflix',
        date: new Date(2026, 2, 15),
        billingMonth: 3,
        billingYear: 2026,
        domainType: 'credit_card_fixed_charge',
        categoryId,
      });

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.fixedExpenses).toHaveLength(1);
      expect(result.fixedExpenses[0].description).toBe('Netflix');
      expect(result.fixedExpenses[0].amount).toBe('55.00');
      expect(result.fixedExpenses[0].source).toBe('Nubank');
      expect(result.fixedExpenses[0].categoryName).toBe('Shopping');
    });
  });

  it('includes recurring scheduled transactions for the month', async () => {
    await withRollback(async (db) => {
      const { service, userId, checkingId, categoryId } = await seed(db);
      const chargeFlow = new ChargeFlowService(db);
      // recurring_bill charge whose first occurrence lands in the queried month.
      await chargeFlow.createFixed(userId, {
        description: 'Gym',
        amount: '200.00',
        sourceAccountId: checkingId,
        startDate: new Date(Date.UTC(2026, 2, 1)),
        dueDay: 5,
        categoryId,
      });

      const result = await service.getMonthlySpending(userId, 3, 2026);

      const gym = result.fixedExpenses.find((e) => e.description === 'Gym');
      if (!gym) throw new Error('expected Gym fixed expense');
      expect(gym.amount).toBe('200.00');
      expect(gym.source).toBe('Recorrente');
      expect(gym.categoryName).toBe('Shopping');
    });
  });
});

// Helper: sum of the recurring portion of the monthly-spending fixed expenses.
// Recurring items are tagged `source: 'Recorrente'` (CC fixed charges carry the
// card name), so this isolates the recurring_bill bucket that must reconcile
// with MonthSummaryService.chargeExpenses.
function recurringFixedTotal(items: { amount: string; source: string }[]): number {
  const total = items
    .filter((e) => e.source === 'Recorrente')
    .reduce((acc, e) => acc.add(Money.fromString(e.amount, 'BRL')), Money.zero('BRL'));
  return total.toNumber();
}

describe('MonthlySpendingService — recurring expenses reconcile with MonthSummaryService', () => {
  it('recurring fixed-expense items equal the dashboard chargeExpenses (materialized rows)', async () => {
    await withRollback(async (db) => {
      const { service, userId, checkingId, categoryId } = await seed(db);
      const chargeFlow = new ChargeFlowService(db);
      // A monthly recurring_bill charge that materializes from this month onward.
      await chargeFlow.createFixed(userId, {
        description: 'Internet',
        amount: '150.00',
        sourceAccountId: checkingId,
        startDate: new Date(Date.UTC(2026, 5, 1)),
        dueDay: 10,
        categoryId,
      });

      const result = await service.getMonthlySpending(userId, 6, 2026);
      const summary = await new MonthSummaryService(db).getSummary(userId, 6, 2026);

      expect(summary.chargeExpenses).toBe(150);
      expect(recurringFixedTotal(result.fixedExpenses)).toBe(summary.chargeExpenses);
    });
  });

  it('a month with no materialized occurrence (beyond the materializer horizon) agrees in both screens', async () => {
    await withRollback(async (db) => {
      const { service, userId, checkingId } = await seed(db);
      const chargeFlow = new ChargeFlowService(db);
      // createFixed materializes a finite 12-month horizon from the start month.
      // The OLD breakdown predicted a recurring item for EVERY month from the
      // start onward (monthsDiff >= 0), so a month past the materialized horizon
      // showed 1 item in the breakdown but 0 in the dashboard (no materialized
      // row exists): exactly the divergence the audit found. Reading materialized
      // rows makes the breakdown agree with the motor — both 0 past the horizon.
      const start = new Date(Date.UTC(2026, 5, 1));
      await chargeFlow.createFixed(userId, {
        description: 'Seguro',
        amount: '99.90',
        sourceAccountId: checkingId,
        startDate: start,
        dueDay: 10,
      });

      // Pick a month well past the 12-month materialization horizon: schedule
      // arithmetic says "active" (no endDate, no totalOccurrences) but no row was
      // materialized there.
      const farMonth = 11; // November
      const farYear = 2028;

      const summary = await new MonthSummaryService(db).getSummary(userId, farMonth, farYear);
      // No materialized occurrence exists that far out → motor reports 0.
      expect(summary.chargeExpenses).toBe(0);

      const result = await service.getMonthlySpending(userId, farMonth, farYear);

      // The breakdown reads materialized rows too, so it agrees with the motor
      // (0) instead of predicting a phantom recurring item from schedule math.
      expect(recurringFixedTotal(result.fixedExpenses)).toBe(summary.chargeExpenses);
    });
  });

  it('reconciles across multiple recurring charges in the same month', async () => {
    await withRollback(async (db) => {
      const { service, userId, checkingId } = await seed(db);
      const chargeFlow = new ChargeFlowService(db);
      await chargeFlow.createFixed(userId, {
        description: 'Plano de saúde',
        amount: '300.00',
        sourceAccountId: checkingId,
        startDate: new Date(Date.UTC(2026, 5, 1)),
        dueDay: 5,
      });
      await chargeFlow.createFixed(userId, {
        description: 'Academia',
        amount: '120.50',
        sourceAccountId: checkingId,
        startDate: new Date(Date.UTC(2026, 5, 1)),
        dueDay: 8,
      });

      const result = await service.getMonthlySpending(userId, 6, 2026);
      const summary = await new MonthSummaryService(db).getSummary(userId, 6, 2026);

      expect(summary.chargeExpenses).toBe(420.5);
      expect(recurringFixedTotal(result.fixedExpenses)).toBe(summary.chargeExpenses);
    });
  });
});

describe('MonthlySpendingService — other expenses', () => {
  it('includes PIX/debit transactions for the month by date', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, checkingId, categoryId } = await seed(db);
      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: checkingId,
        amount: '80.00',
        description: 'Pharmacy',
        date: new Date(2026, 2, 20),
        categoryId,
      });

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.otherExpenses).toHaveLength(1);
      expect(result.otherExpenses[0].description).toBe('Pharmacy');
      expect(result.otherExpenses[0].amount).toBe('80.00');
      expect(result.otherExpenses[0].sourceAccountName).toBe('Expenses');
      expect(result.otherExpenses[0].categoryName).toBe('Shopping');
    });
  });

  it('excludes credit card and loan transactions from other expenses', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, creditCardId, checkingId } = await seed(db);
      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '500.00',
        description: 'TV',
        date: new Date(2026, 2, 5),
        billingMonth: 3,
        billingYear: 2026,
        installmentNumber: 1,
        totalInstallments: 10,
        domainType: 'credit_card_installment',
      });

      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: checkingId,
        amount: '50.00',
        description: 'Supermarket',
        date: new Date(2026, 2, 15),
      });

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.otherExpenses.every((e) => e.description !== 'TV')).toBe(true);
      expect(result.otherExpenses.some((e) => e.description === 'Supermarket')).toBe(true);
    });
  });
});

describe('MonthlySpendingService — precision', () => {
  it('sums credit card amounts via Money (no float drift on odd cents)', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, creditCardId } = await seed(db);

      // 30 items of 33.33 → exact 999.90 in Decimal,
      // 999.8999999... in float arithmetic.
      for (let i = 0; i < 30; i++) {
        await createTransaction(txService, userId, {
          sourceAccountId: expenseId,
          destinationAccountId: creditCardId,
          amount: '33.33',
          description: `Drift item ${i}`,
          date: new Date(2026, 2, (i % 28) + 1),
          billingMonth: 3,
          billingYear: 2026,
          domainType: 'credit_card_installment',
        });
      }

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.creditCards).toHaveLength(1);
      expect(result.creditCards[0].total).toBe('999.90');
      expect(result.summary.total).toBe('999.90');
      expect(result.summary.byType.creditCards.total).toBe('999.90');
      expect(result.summary.oneTimeExpenses.total).toBe('999.90');
    });
  });
});

describe('MonthlySpendingService — summary', () => {
  it('returns correct summary for credit card spending', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, creditCardId } = await seed(db);
      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '1000.00',
        description: 'Laptop',
        date: new Date(2026, 2, 5),
        billingMonth: 3,
        billingYear: 2026,
        installmentNumber: 1,
        totalInstallments: 5,
        domainType: 'credit_card_installment',
      });

      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '200.00',
        description: 'Book',
        date: new Date(2026, 2, 10),
        billingMonth: 3,
        billingYear: 2026,
        domainType: 'credit_card_installment',
      });

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.month).toBe(3);
      expect(result.year).toBe(2026);
      expect(result.summary.byType.creditCards.total).toBe('1200.00');
      expect(result.summary.byType.creditCards.count).toBe(1);
      expect(result.summary.byType.creditCards.itemCount).toBe(2);
      expect(result.summary.total).toBe('1200.00');
      expect(result.summary.newInstallments.total).toBe('5000.00');
      expect(result.summary.newInstallments.count).toBe(1);
      expect(result.summary.oneTimeExpenses.total).toBe('200.00');
      expect(result.summary.oneTimeExpenses.count).toBe(1);
    });
  });

  it('calculates correct totals across all expense types', async () => {
    await withRollback(async (db) => {
      const { txService, service, userId, expenseId, creditCardId, checkingId } = await seed(db);
      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: creditCardId,
        amount: '55.00',
        description: 'Netflix',
        date: new Date(2026, 2, 15),
        billingMonth: 3,
        billingYear: 2026,
        domainType: 'credit_card_fixed_charge',
      });

      await createTransaction(txService, userId, {
        sourceAccountId: expenseId,
        destinationAccountId: checkingId,
        amount: '80.00',
        description: 'Pharmacy',
        date: new Date(2026, 2, 20),
      });

      const result = await service.getMonthlySpending(userId, 3, 2026);

      expect(result.summary.byType.fixedExpenses.total).toBe('55.00');
      expect(result.summary.byType.fixedExpenses.count).toBe(1);
      expect(result.summary.byType.other.total).toBe('80.00');
      expect(result.summary.byType.other.count).toBe(1);
      expect(result.summary.oneTimeExpenses.total).toBe('80.00');
      expect(result.summary.oneTimeExpenses.count).toBe(1);
    });
  });
});
