import { accounts, loanConfigs, scheduledTransactions } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { loanCostEvidenceSchema } from '../lib/loan-cost-input.ts';
import { AccountService } from '../services/account.service.ts';
import { LoanFlowService } from '../services/loan-flow.service.ts';
import {
  computeCurrentInstallment,
  countUnpaidInstallmentsThroughMonth,
} from '../services/loan-installment.ts';
import { ScheduledService } from '../services/scheduled.service.ts';
import { protectedProcedure, router } from '../trpc.ts';
import {
  loanCategorySchema,
  loanTypeSchema,
  moneySchema,
  payoffCalculationTypeSchema,
} from './schemas.ts';

export const loanRouter = router({
  markOccurrenceAsPaid: protectedProcedure
    .input(
      z.object({
        accountId: z.guid(),
        transactionId: z.guid(),
        paidFromAccountId: z.guid(),
        settlementDate: z.date(),
        expectedRevision: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      new LoanFlowService(ctx.db).markOccurrenceAsPaid(ctx.userId, input),
    ),
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        loanCategory: loanCategorySchema,
        loanType: loanTypeSchema,
        paymentMethod: z.enum(['bank_debit', 'payroll', 'manual']).optional(),
        incomeSourceAccountId: z.guid().nullable().optional(),
        monthlyPayment: moneySchema,
        totalInstallments: z.number().int().positive(),
        // Optional: when omitted, the service derives it from the first
        // installment date. May be 0/negative when the loan starts in a future
        // month (nothing due yet).
        currentInstallment: z.number().int().optional(),
        dueDay: z.number().int().min(1).max(31),
        startDate: z.date(),
        checkingAccountId: z.guid(),
        monthlyInterestRate: z.string(),
        annualInterestRate: z.string().optional(),
        insuranceAmount: moneySchema.optional(),
        insurancePaymentDay: z.number().int().min(1).max(31).optional(),
        payoffCalculationType: payoffCalculationTypeSchema.optional(),
        principalAmount: moneySchema.optional(),
        originalAmount: moneySchema.optional(),
        comment: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new LoanFlowService(ctx.db);
      return service.createLoan(ctx.userId, input);
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const loanAccounts = await ctx.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, ctx.userId),
          eq(accounts.type, 'loan'),
          eq(accounts.isActive, true),
        ),
      );

    const result = await Promise.all(
      loanAccounts.map(async (account) => {
        const [config] = await ctx.db
          .select()
          .from(loanConfigs)
          .where(eq(loanConfigs.accountId, account.id));

        let schedule = null;
        if (config) {
          const schedules = await ctx.db
            .select()
            .from(scheduledTransactions)
            .where(
              and(
                eq(scheduledTransactions.domainConfigId, config.id),
                eq(scheduledTransactions.domainType, 'loan_payment'),
                eq(scheduledTransactions.isActive, true),
              ),
            );
          schedule = schedules[0] ?? null;
        }

        const currentInstallment = await computeCurrentInstallment(ctx.db, account.id);
        const overdueCount = await countUnpaidInstallmentsThroughMonth(ctx.db, account.id);
        const isCurrentMonthPaid = overdueCount === 0;
        const isPaidOff =
          config !== undefined &&
          currentInstallment >= config.totalInstallments &&
          isCurrentMonthPaid;

        return {
          account,
          config: config ?? null,
          schedule,
          currentInstallment,
          overdueCount,
          isCurrentMonthPaid,
          isPaidOff,
        };
      }),
    );

    return result;
  }),

  getById: protectedProcedure
    .input(z.object({ accountId: z.guid() }))
    .query(async ({ ctx, input }) => {
      const [account] = await ctx.db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, ctx.userId)));

      if (!account) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Loan not found' });
      }

      const [config] = await ctx.db
        .select()
        .from(loanConfigs)
        .where(eq(loanConfigs.accountId, input.accountId));

      const currentInstallment = await computeCurrentInstallment(ctx.db, input.accountId);
      // Used to tell "on the last installment" apart from "actually paid off".
      const overdueCount = await countUnpaidInstallmentsThroughMonth(ctx.db, input.accountId);
      const isCurrentMonthPaid = overdueCount === 0;

      const service = new LoanFlowService(ctx.db);
      const payoff = config ? await service.getPayoffInfo(ctx.userId, input.accountId) : null;

      const configWithInstallment = config ? { ...config, currentInstallment } : null;

      return { account, config: configWithInstallment, payoff, isCurrentMonthPaid };
    }),

  getPayoff: protectedProcedure
    .input(z.object({ accountId: z.guid() }))
    .query(async ({ ctx, input }) => {
      const service = new LoanFlowService(ctx.db);
      return service.getPayoffInfo(ctx.userId, input.accountId);
    }),

  markCurrentAsPaid: protectedProcedure
    .input(
      z.object({
        accountId: z.guid(),
        paidFromAccountId: z.guid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new LoanFlowService(ctx.db);
      return service.markCurrentAsPaid(ctx.userId, input.accountId, input.paidFromAccountId);
    }),

  markCurrentAsUnpaid: protectedProcedure
    .input(z.object({ accountId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const service = new LoanFlowService(ctx.db);
      return service.markCurrentAsUnpaid(ctx.userId, input.accountId);
    }),

  getNextPayable: protectedProcedure
    .input(z.object({ accountId: z.guid() }))
    .query(async ({ ctx, input }) => {
      const service = new LoanFlowService(ctx.db);
      return service.getNextPayable(ctx.userId, input.accountId);
    }),

  advanceMonth: protectedProcedure
    .input(z.object({ accountId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const service = new LoanFlowService(ctx.db);
      return service.advanceMonth(ctx.userId, input.accountId);
    }),

  update: protectedProcedure
    .input(
      z.object({
        accountId: z.guid(),
        name: z.string().min(1).max(200).optional(),
        monthlyPayment: moneySchema.optional(),
        dueDay: z.number().int().min(1).max(31).optional(),
        comment: z.string().nullable().optional(),
        costEvidence: loanCostEvidenceSchema.optional(),
        paymentMethod: z.enum(['bank_debit', 'payroll', 'manual']).nullable().optional(),
        incomeSourceAccountId: z.guid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const accountService = new AccountService(ctx.db);
      await accountService.getById(ctx.userId, input.accountId);

      if (input.costEvidence !== undefined) {
        await new LoanFlowService(ctx.db).updateCostEvidence(
          ctx.userId,
          input.accountId,
          input.costEvidence,
        );
      }

      if (input.paymentMethod !== undefined || input.incomeSourceAccountId !== undefined) {
        const [config] = await ctx.db
          .select()
          .from(loanConfigs)
          .where(eq(loanConfigs.accountId, input.accountId));
        const method =
          input.paymentMethod === undefined ? (config?.paymentMethod ?? null) : input.paymentMethod;
        const source =
          method === 'payroll'
            ? input.incomeSourceAccountId === undefined
              ? (config?.incomeSourceAccountId ?? null)
              : input.incomeSourceAccountId
            : null;
        await new LoanFlowService(ctx.db).setPaymentMethod(
          ctx.userId,
          input.accountId,
          method,
          source,
        );
      }

      if (input.name !== undefined) {
        await ctx.db
          .update(accounts)
          .set({ name: input.name, updatedAt: new Date() })
          .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, ctx.userId)));
      }

      const configUpdates: Record<string, unknown> = {};
      if (input.monthlyPayment !== undefined) configUpdates.monthlyPayment = input.monthlyPayment;
      if (input.dueDay !== undefined) configUpdates.dueDay = input.dueDay;
      if (input.comment !== undefined) configUpdates.comment = input.comment;

      if (Object.keys(configUpdates).length > 0) {
        configUpdates.updatedAt = new Date();
        // loanConfigs has no userId column; tenancy is enforced via the
        // linked account so a forged accountId cannot hit another tenant
        // even under TOCTOU with the ownership check above.
        await ctx.db
          .update(loanConfigs)
          .set(configUpdates)
          .where(
            and(
              eq(loanConfigs.accountId, input.accountId),
              sql`EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.id} = ${loanConfigs.accountId} AND ${accounts.userId} = ${ctx.userId})`,
            ),
          );
      }

      return { success: true };
    }),

  deactivate: protectedProcedure
    .input(z.object({ accountId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const accountService = new AccountService(ctx.db);
      const scheduledService = new ScheduledService(ctx.db);

      await accountService.deactivate(ctx.userId, input.accountId);

      const schedules = await scheduledService.listByUser(ctx.userId);
      for (const s of schedules) {
        if (s.sourceAccountId === input.accountId || s.destinationAccountId === input.accountId) {
          await scheduledService.deactivate(ctx.userId, s.id);
        }
      }

      return { success: true };
    }),
});
