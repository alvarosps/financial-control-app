import type { DbExecutor } from '@fc/db';
import { materializationStatus, transactions, userProfiles } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { LoanFlowService } from './loan-flow.service.ts';
import { ScheduledService } from './scheduled.service.ts';
import { SimulatorService } from './simulator.service.ts';

async function txCount(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`COUNT(*)` })
    .from(transactions)
    .where(eq(transactions.userId, userId));
  return Number.parseInt(row.n, 10);
}

async function matStatusCount(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`COUNT(*)` })
    .from(materializationStatus)
    .where(eq(materializationStatus.userId, userId));
  return Number.parseInt(row.n, 10);
}

describe('SimulatorService.run — no writes (noOpGuard)', () => {
  it('does not materialize: transactions and materialization_status row counts are unchanged', async () => {
    await withRollback(async (db) => {
      const accountService = new AccountService(db);
      const loanFlowService = new LoanFlowService(db);
      const scheduledService = new ScheduledService(db);
      const simulatorService = new SimulatorService(db);

      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'sim-nowrite@test.com', name: 'NoWrite', passwordHash: 'hash' })
        .returning();
      const userId = user.id;

      const checking = await accountService.create(userId, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const expenseAcc = await accountService.create(userId, {
        name: 'Subscriptions',
        type: 'expense',
        currency: 'BRL',
      });

      // A real active recurring schedule the materializer COULD expand. Amounts
      // are stored positive (sched_amount_positive CHECK); direction comes from
      // the checking -> expense account pair, so this is an outflow.
      await scheduledService.create(userId, {
        description: 'Streaming',
        amount: '49.90',
        frequency: 'monthly',
        startDate: new Date(2026, 0, 5),
        sourceAccountId: checking.id,
        destinationAccountId: expenseAcc.id,
      });

      // A loan, so loan_payment rows would also be materializable.
      await loanFlowService.createLoan(userId, {
        name: 'Consignado',
        loanCategory: 'bank',
        loanType: 'consignado',
        monthlyPayment: '1000.00',
        totalInstallments: 48,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 0, 10),
        checkingAccountId: checking.id,
        monthlyInterestRate: '0.01990000',
        payoffCalculationType: 'consignado_mensal',
      });

      const beforeTx = await txCount(db, userId);
      const beforeMat = await matStatusCount(db, userId);

      const result = await simulatorService.run(userId, {
        horizon: 12,
        levers: [],
        asOf: new Date(2026, 5, 16),
      });

      const afterTx = await txCount(db, userId);
      const afterMat = await matStatusCount(db, userId);

      // The run produced a real projection...
      expect(result.baseline.length).toBe(12);
      expect(result.assumptions.horizon).toBe(12);
      // ...but wrote NOTHING.
      expect(afterTx).toBe(beforeTx);
      expect(afterMat).toBe(beforeMat);
    });
  });
});
