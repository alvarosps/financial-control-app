import { z } from 'zod';
import { paginationSchema } from '../lib/pagination.ts';
import { CashMovementService } from '../services/cash-movement.service.ts';
import { FinancialObligationsService } from '../services/financial-obligations.service.ts';
import { MaterializationGuard } from '../services/materialization-guard.service.ts';
import { TransactionService } from '../services/transaction.service.ts';
import { protectedProcedure, router } from '../trpc.ts';
import { domainTypeSchema, moneySchema, notesSchema, positiveRateSchema } from './schemas.ts';

export const transactionRouter = router({
  details: protectedProcedure
    .input(
      z
        .object({
          month: z.number().int().min(1).max(12),
          year: z.number().int().min(2000).max(2100),
          accountId: z.guid().optional(),
          type: z.enum(['deposit', 'withdrawal', 'transfer']).optional(),
        })
        .merge(paginationSchema),
    )
    .query(({ ctx, input }) => new TransactionService(ctx.db).listByPeriod(ctx.userId, input)),
  cashMovements: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
        accountId: z.guid().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(40),
      }),
    )
    .query(({ ctx, input }) => new CashMovementService(ctx.db).list(ctx.userId, input)),
  obligations: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
        accountId: z.guid().optional(),
        kind: z
          .enum(['card_bill', 'charge', 'loan_installment', 'income', 'family_receivable', 'other'])
          .optional(),
      }),
    )
    .query(({ ctx, input }) =>
      new FinancialObligationsService(ctx.db, new MaterializationGuard(ctx.db)).listForDuePeriod(
        ctx.userId,
        input.month,
        input.year,
        input.accountId,
        input.kind,
      ),
    ),
  list: protectedProcedure
    .input(
      z
        .object({
          month: z.number().int().min(1).max(12),
          year: z.number().int().min(2000),
          accountId: z.guid().optional(),
        })
        .merge(paginationSchema.partial()),
    )
    .query(async ({ ctx, input }) => {
      const service = new TransactionService(ctx.db);
      return service.listByPeriod(ctx.userId, input);
    }),

  getById: protectedProcedure.input(z.object({ id: z.guid() })).query(async ({ ctx, input }) => {
    const service = new TransactionService(ctx.db);
    return service.getById(ctx.userId, input.id);
  }),

  create: protectedProcedure
    .input(
      z.object({
        sourceAccountId: z.guid(),
        destinationAccountId: z.guid(),
        amount: moneySchema,
        description: z.string().min(1).max(500),
        date: z.date(),
        notes: notesSchema.optional(),
        categoryId: z.guid().optional(),
        billingMonth: z.number().int().min(1).max(12).optional(),
        billingYear: z.number().int().min(2000).optional(),
        installmentNumber: z.number().int().positive().optional(),
        totalInstallments: z.number().int().positive().optional(),
        domainType: domainTypeSchema.optional(),
        exchangeRate: positiveRateSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new TransactionService(ctx.db);
      return service.create(ctx.userId, input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.guid(),
        description: z.string().min(1).max(500).optional(),
        amount: moneySchema.optional(),
        categoryId: z.guid().nullable().optional(),
        date: z.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const service = new TransactionService(ctx.db);
      return service.update(ctx.userId, id, fields);
    }),

  reverse: protectedProcedure.input(z.object({ id: z.guid() })).mutation(async ({ ctx, input }) => {
    const service = new TransactionService(ctx.db);
    return service.reverse(ctx.userId, input.id);
  }),

  markAsPaid: protectedProcedure
    .input(
      z.object({
        id: z.guid(),
        paidFromAccountId: z.guid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new TransactionService(ctx.db);
      return service.markAsPaid(ctx.userId, input.id, input.paidFromAccountId);
    }),

  markAsUnpaid: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const service = new TransactionService(ctx.db);
      return service.markAsUnpaid(ctx.userId, input.id);
    }),
});
