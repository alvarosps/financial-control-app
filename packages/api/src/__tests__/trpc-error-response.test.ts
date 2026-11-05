import { accounts, categories, monthClosings, transactions } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { errorCause } from '../lib/error-codes.ts';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory, protectedProcedure, router } from '../trpc.ts';

const format = router({})._def._config.errorFormatter;

function response(error: TRPCError) {
  return format({
    error,
    type: 'mutation',
    path: 'faturaImport.uploadManual',
    input: undefined,
    ctx: undefined,
    shape: {
      message: error.message,
      code: -32603,
      data: { code: error.code, httpStatus: 500, stack: 'Failed query params: confidential' },
    },
  });
}

describe('tRPC error response', () => {
  it('returns a localized conflict for a real closed-period SQL rejection and rolls back earlier writes', async () => {
    await withRollback(async (db) => {
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
          description: 'Private fixture',
          date: new Date('2026-08-10'),
        })
        .returning();
      await db
        .insert(monthClosings)
        .values({ userId: user.id, month: 8, year: 2026, status: 'closed' });
      const probe = router({
        edit: protectedProcedure.mutation(async ({ ctx }) => {
          await ctx.db
            .insert(categories)
            .values({ userId: ctx.userId, name: 'Must roll back', type: 'expense' });
          await ctx.db
            .update(transactions)
            .set({ amount: '20.00' })
            .where(eq(transactions.id, row.id));
        }),
      });
      const caller = createCallerFactory(probe)({
        db,
        userId: user.id,
        profileCache: createRequestProfileCache(db),
      });
      const error = await caller.edit().catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        code: 'CONFLICT',
        cause: { i18nKey: 'errors.financial.periodClosed' },
      });
      if (!(error instanceof TRPCError)) throw new Error('Expected tRPC error');
      const shape = response(error);
      expect(shape.data.i18nKey).toBe('errors.financial.periodClosed');
      expect(shape.message).toMatch(/reopen/i);
      expect(JSON.stringify(shape)).not.toMatch(
        /Private fixture|Failed query|confidential|UPDATE/i,
      );
      expect(await db.select().from(categories).where(eq(categories.userId, user.id))).toEqual([]);
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, row.id)))[0].amount,
      ).toBe('10.00');
    });
  });
  it.each([
    '55P03',
    '57014',
    '40P01',
    '40001',
    '53300',
  ])('provides retry guidance for nested PostgreSQL error %s without SQL or parameters', (code) => {
    const databaseError = Object.assign(new Error('database detail: confidential'), { code });
    const queryError = new Error(
      'Failed query: select id from accounts for update; params: confidential',
      { cause: databaseError },
    );
    const shape = response(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: queryError }));
    expect(shape.data.i18nKey).toBe('errors.server.busy');
    expect(JSON.stringify(shape)).not.toMatch(/confidential|select id|Failed query/);
  });

  it('does not expose SQL or a stack for unexpected server errors', () => {
    const shape = response(
      new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed query with confidential parameters',
      }),
    );
    expect(shape.data.i18nKey).toBe('errors.server.unexpected');
    expect(JSON.stringify(shape)).not.toMatch(/confidential|Failed query/);
  });

  it('preserves actionable business errors', () => {
    const shape = response(
      new TRPCError({
        code: 'CONFLICT',
        message: 'Bill already paid',
        cause: errorCause('bill.alreadyPaid'),
      }),
    );
    expect(shape.message).toBe('Bill already paid');
    expect(shape.data.i18nKey).toBe('errors.bill.alreadyPaid');
  });
});
