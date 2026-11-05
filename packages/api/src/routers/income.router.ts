import type { DbExecutor } from '@fc/db';
import { transactions } from '@fc/db';
import { getDomainTypesByGroup } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { bestEffortFxRefresh } from '../lib/fx-refresh.ts';
import { createGuardedServices } from '../lib/service-factory.ts';
import { AccountService } from '../services/account.service.ts';
import { DueIncomeAutoCreditService } from '../services/due-income-auto-credit.service.ts';
import { IncomeFlowService } from '../services/income-flow.service.ts';
import { IncomeOccurrenceService } from '../services/income-occurrence.service.ts';
import { PayrollSettlementService } from '../services/payroll-settlement.service.ts';
import { ScheduledService } from '../services/scheduled.service.ts';
import { SettlementService } from '../services/settlement.service.ts';
import { protectedProcedure, router } from '../trpc.ts';
import { incomeCategorySchema, moneySchema, positiveRateSchema } from './schemas.ts';

const INCOME_DOMAIN_TYPES = new Set(getDomainTypesByGroup('income'));

/**
 * Load a user-owned transaction and assert it is a settleable INCOME row.
 * Guards mark-received / mark-unreceived so a crafted `transactionId` cannot
 * redirect an expense/loan/reversed row through the income settlement path.
 * `requireUnpaid` enforces the precondition for the verb (received vs. unreceived).
 */
async function assertSettleableIncomeTx(
  db: DbExecutor,
  userId: string,
  transactionId: string,
  requireUnpaid: boolean,
) {
  const [tx] = await db
    .select({
      id: transactions.id,
      domainType: transactions.domainType,
      isPaid: transactions.isPaid,
      isReversed: transactions.isReversed,
      currency: transactions.currency,
      settlementSource: transactions.settlementSource,
    })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)));
  if (!tx) throw new TRPCError({ code: 'NOT_FOUND', message: 'Transaction not found' });
  if (tx.domainType == null || !INCOME_DOMAIN_TYPES.has(tx.domainType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Transaction is not an income occurrence',
    });
  }
  if (tx.isReversed) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Transaction has been reversed' });
  }
  if (requireUnpaid && tx.isPaid && tx.settlementSource !== 'date_assumed') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Occurrence is already received' });
  }
  return tx;
}

export const incomeRouter = router({
  payrollOptions: protectedProcedure
    .input(z.object({ incomeTransactionId: z.guid() }))
    .query(({ ctx, input }) =>
      new PayrollSettlementService(ctx.db).options(ctx.userId, input.incomeTransactionId),
    ),
  settlePayroll: protectedProcedure
    .input(
      z.object({
        incomeTransactionId: z.guid(),
        loanTransactionIds: z.array(z.guid()).min(1).max(100),
        walletAccountId: z.guid(),
        settlementDate: z.date(),
        reportedNetBrl: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/)
          .optional(),
        acknowledgeDifference: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => new PayrollSettlementService(ctx.db).settle(ctx.userId, input)),
  undoPayroll: protectedProcedure
    .input(z.object({ incomeTransactionId: z.guid() }))
    .mutation(({ ctx, input }) =>
      new PayrollSettlementService(ctx.db).undo(ctx.userId, input.incomeTransactionId),
    ),
  create: protectedProcedure
    .input(
      z.object({
        description: z.string().min(1).max(200),
        amount: moneySchema,
        frequency: z.enum(['monthly', 'biweekly', 'weekly', 'annual', 'one_time']),
        category: incomeCategorySchema,
        destinationAccountId: z.guid(),
        startDate: z.date(),
        paymentDay: z.number().int().min(1).max(31).optional(),
        exchangeRate: positiveRateSchema.optional(),
        currency: z.string().length(3).optional(),
        autoCreditByDate: z.boolean().optional(),
        biweeklyAnchor: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new IncomeFlowService(ctx.db);
      return service.createIncomeSource(ctx.userId, input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        accountId: z.guid(),
        description: z.string().min(1).max(200).optional(),
        amount: moneySchema.optional(),
        frequency: z.enum(['monthly', 'biweekly', 'weekly', 'annual', 'one_time']).optional(),
        category: incomeCategorySchema.optional(),
        paymentDay: z.number().int().min(1).max(31).nullable().optional(),
        exchangeRate: positiveRateSchema.nullable().optional(),
        currency: z.string().length(3).optional(),
        autoCreditByDate: z.boolean().optional(),
        startDate: z.date().optional(),
        biweeklyAnchor: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new IncomeFlowService(ctx.db);
      return service.update(ctx.userId, input);
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const { fxRate } = createGuardedServices(ctx.db);
    // Once-per-day USD→BRL refresh so listed income reflects today's rate;
    // cheap on the fast path and never throws.
    await bestEffortFxRefresh(fxRate);
    const service = new IncomeFlowService(ctx.db);
    return service.list(ctx.userId);
  }),

  getById: protectedProcedure
    .input(z.object({ accountId: z.guid() }))
    .query(async ({ ctx, input }) => {
      const service = new IncomeFlowService(ctx.db);
      const result = await service.getById(ctx.userId, input.accountId);
      if (!result) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Income source not found' });
      }
      return result;
    }),

  occurrences: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const service = new IncomeOccurrenceService(ctx.db);
      return service.getOccurrences(ctx.userId, input.month, input.year);
    }),

  autoCreditDue: protectedProcedure.query(async ({ ctx }) => {
    const { guard } = createGuardedServices(ctx.db);
    const service = new DueIncomeAutoCreditService(ctx.db, guard);
    return service.run(ctx.userId, new Date());
  }),

  markOccurrenceAsReceived: protectedProcedure
    .input(
      z.object({
        transactionId: z.guid(),
        paidToAccountId: z.guid(),
        amountBrl: moneySchema.optional(),
        settlementDate: z.date().optional(),
        expectedRevision: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tx = await assertSettleableIncomeTx(ctx.db, ctx.userId, input.transactionId, true);
      // A forex (non-BRL) occurrence MUST be settled with the realized BRL amount;
      // otherwise it stays currency=USD with is_paid=true and gets double-converted
      // by the month aggregates.
      if (tx.currency !== 'BRL' && input.amountBrl === undefined) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Renda em moeda estrangeira exige o valor recebido em BRL',
        });
      }
      const settlement = new SettlementService(ctx.db);
      return settlement.settle(ctx.userId, {
        transactionId: input.transactionId,
        walletAccountId: input.paidToAccountId,
        leg: 'destination',
        settlementDate: input.settlementDate,
        expectedRevision: input.expectedRevision,
        ...(input.amountBrl !== undefined && { amountOverrideBrl: input.amountBrl }),
      });
    }),

  markOccurrenceAsUnreceived: protectedProcedure
    .input(z.object({ transactionId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      await assertSettleableIncomeTx(ctx.db, ctx.userId, input.transactionId, false);
      const settlement = new SettlementService(ctx.db);
      return settlement.unsettle(ctx.userId, input.transactionId);
    }),

  editReceivedAmount: protectedProcedure
    .input(
      z.object({
        transactionId: z.guid(),
        amountBrl: moneySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new IncomeFlowService(ctx.db);
      return service.editReceivedAmount(ctx.userId, input);
    }),

  deactivate: protectedProcedure
    .input(z.object({ accountId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const accountService = new AccountService(ctx.db);
      const scheduledService = new ScheduledService(ctx.db);

      await accountService.deactivate(ctx.userId, input.accountId);

      const incomeDomainTypes = getDomainTypesByGroup('income');
      for (const domainType of incomeDomainTypes) {
        const schedules = await scheduledService.listByDomainType(ctx.userId, domainType);
        for (const s of schedules) {
          if (s.sourceAccountId === input.accountId) {
            await scheduledService.deactivate(ctx.userId, s.id);
          }
        }
      }

      return { success: true };
    }),
});
