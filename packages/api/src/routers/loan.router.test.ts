import type { DbExecutor } from '@fc/db';
import { accounts } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { AccountService } from '../services/account.service.ts';
import { LoanFlowService } from '../services/loan-flow.service.ts';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);

async function seed(db: DbExecutor) {
  const user = await createTestUser(db);
  const checking = await new AccountService(db).create(user.id, {
    name: 'Checking',
    type: 'checking',
    currency: 'BRL',
  });
  const caller = createCaller({
    db,
    userId: user.id,
    profileCache: createRequestProfileCache(db),
  });
  return { user, checking, caller };
}

describe('loan.list', () => {
  it('distinguishes open, paid-off, and future loans', async () => {
    await withRollback(async (db) => {
      const { user, checking, caller } = await seed(db);
      const flow = new LoanFlowService(db);
      const now = new Date();
      const currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 5));
      const futureStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 5));
      const common = {
        loanCategory: 'bank' as const,
        loanType: 'pessoal' as const,
        monthlyPayment: '100.00',
        dueDay: 5,
        checkingAccountId: checking.id,
        monthlyInterestRate: '0.00000000',
      };

      await flow.createLoan(user.id, {
        ...common,
        name: 'Open loan',
        totalInstallments: 2,
        startDate: currentStart,
      });
      const completed = await flow.createLoan(user.id, {
        ...common,
        name: 'Paid-off loan',
        totalInstallments: 1,
        startDate: currentStart,
      });
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
        .where(eq(accounts.id, checking.id));
      await flow.markCurrentAsPaid(user.id, completed.account.id, checking.id);
      await flow.createLoan(user.id, {
        ...common,
        name: 'Future loan',
        totalInstallments: 2,
        startDate: futureStart,
      });

      const loans = await caller.loan.list();
      const byName = new Map(loans.map((loan) => [loan.account.name, loan]));

      expect(byName.get('Open loan')?.isPaidOff).toBe(false);
      expect(byName.get('Paid-off loan')?.isPaidOff).toBe(true);
      expect(byName.get('Future loan')?.isPaidOff).toBe(false);
    });
  });
});
