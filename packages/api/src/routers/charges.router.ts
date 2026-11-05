import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ChargeFlowService } from '../services/charge-flow.service.ts';
import { protectedProcedure, rateLimit, router } from '../trpc.ts';
import { moneySchema } from './schemas.ts';

export const chargesRouter = router({
  createFixed: protectedProcedure
    .input(
      z.object({
        description: z.string().min(1).max(200),
        amount: moneySchema,
        sourceAccountId: z.guid(),
        startDate: z.date(),
        dueDay: z.number().int().min(1).max(31),
        endDate: z.date().optional(),
        categoryId: z.guid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new ChargeFlowService(ctx.db);
      return service.createFixed(ctx.userId, input);
    }),

  createOneTime: protectedProcedure
    .input(
      z.object({
        description: z.string().min(1).max(200),
        amount: moneySchema,
        sourceAccountId: z.guid(),
        date: z.date(),
        dueDay: z.number().int().min(1).max(31).optional(),
        categoryId: z.guid().optional(),
        isPaid: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new ChargeFlowService(ctx.db);
      return service.createOneTime(ctx.userId, input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        scheduleId: z.guid(),
        description: z.string().min(1).max(200).optional(),
        amount: moneySchema.optional(),
        dueDay: z.number().int().min(1).max(31).optional(),
        endDate: z.date().nullable().optional(),
        categoryId: z.guid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new ChargeFlowService(ctx.db);
      return service.update(ctx.userId, input);
    }),

  list: protectedProcedure
    .input(
      z
        .object({
          month: z.number().int().min(1).max(12),
          year: z.number().int().min(2000).max(2100),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const service = new ChargeFlowService(ctx.db);
      return service.list(ctx.userId, input?.month, input?.year);
    }),

  getById: protectedProcedure
    .input(z.object({ scheduleId: z.guid() }))
    .query(async ({ ctx, input }) => {
      const service = new ChargeFlowService(ctx.db);
      const result = await service.getById(ctx.userId, input.scheduleId);
      if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'Charge not found' });
      return result;
    }),

  deactivate: protectedProcedure
    .input(z.object({ scheduleId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const service = new ChargeFlowService(ctx.db);
      return service.deactivate(ctx.userId, input.scheduleId);
    }),

  // Money-moving settlement mutations — rate-limited like credit-card.payBill
  // (shared 'charge.pay' bucket via the default token-bucket limiter). Chained
  // after the auth guard so anon callers get UNAUTHORIZED, not throttling.
  markOccurrenceAsPaid: protectedProcedure
    .use(rateLimit('charge.pay'))
    .input(
      z.object({
        transactionId: z.guid(),
        paidFromAccountId: z.guid(),
        settlementDate: z.date().optional(),
        expectedRevision: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new ChargeFlowService(ctx.db);
      return service.markOccurrenceAsPaid(
        ctx.userId,
        input.transactionId,
        input.paidFromAccountId,
        input.settlementDate,
        input.expectedRevision,
      );
    }),

  markOccurrenceAsUnpaid: protectedProcedure
    .use(rateLimit('charge.pay'))
    .input(z.object({ transactionId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const service = new ChargeFlowService(ctx.db);
      return service.markOccurrenceAsUnpaid(ctx.userId, input.transactionId);
    }),
});
