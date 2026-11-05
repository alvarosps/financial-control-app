import { z } from 'zod';
import { paginationSchema } from '../lib/pagination.ts';
import { MaterializerService } from '../services/materializer.service.ts';
import { ScheduledService } from '../services/scheduled.service.ts';
import { protectedProcedure, router } from '../trpc.ts';
import { domainTypeSchema, moneySchema, notesSchema } from './schemas.ts';

const frequencyValues = [
  'once',
  'weekly',
  'biweekly',
  'monthly',
  'bimonthly',
  'quarterly',
  'semiannual',
  'annual',
] as const;

export const scheduledRouter = router({
  list: protectedProcedure
    .input(paginationSchema.partial().optional())
    .query(async ({ ctx, input }) => {
      const service = new ScheduledService(ctx.db);
      if (input?.page !== undefined) {
        return service.listByUser(ctx.userId, input.page, input.pageSize);
      }
      return service.listByUser(ctx.userId);
    }),

  getById: protectedProcedure.input(z.object({ id: z.guid() })).query(async ({ ctx, input }) => {
    const service = new ScheduledService(ctx.db);
    return service.getById(ctx.userId, input.id);
  }),

  listByDomainType: protectedProcedure
    .input(z.object({ domainType: domainTypeSchema }))
    .query(async ({ ctx, input }) => {
      const service = new ScheduledService(ctx.db);
      return service.listByDomainType(ctx.userId, input.domainType);
    }),

  create: protectedProcedure
    .input(
      z.object({
        sourceAccountId: z.guid(),
        destinationAccountId: z.guid(),
        amount: moneySchema,
        description: z.string().min(1).max(500),
        frequency: z.enum(frequencyValues),
        startDate: z.date(),
        endDate: z.date().optional(),
        dueDay: z.number().int().min(1).max(31).optional(),
        totalOccurrences: z.number().int().positive().optional(),
        startingOccurrence: z
          .number()
          .int()
          .refine((v) => v === 1, {
            message: 'startingOccurrence must be 1 - backdate startDate instead',
          })
          .optional(),
        categoryId: z.guid().optional(),
        notes: notesSchema.optional(),
        domainType: domainTypeSchema.optional(),
        domainConfigId: z.guid().optional(),
        isFixedCharge: z.boolean().optional(),
        firstBillingMonth: z.number().int().min(1).max(12).optional(),
        firstBillingYear: z.number().int().min(2000).max(2100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new ScheduledService(ctx.db);
      return service.create(ctx.userId, input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.guid(),
        description: z.string().min(1).max(500).optional(),
        amount: moneySchema.optional(),
        dueDay: z.number().int().min(1).max(31).optional(),
        endDate: z.date().nullable().optional(),
        notes: notesSchema.optional(),
        categoryId: z.guid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const service = new ScheduledService(ctx.db);
      return service.update(ctx.userId, id, fields);
    }),

  deactivate: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const service = new ScheduledService(ctx.db);
      return service.deactivate(ctx.userId, input.id);
    }),

  // Delete a scheduled item from current/future bills: deactivate + purge unpaid
  // non-reversed materialized rows (paid history preserved).
  delete: protectedProcedure.input(z.object({ id: z.guid() })).mutation(async ({ ctx, input }) => {
    const service = new ScheduledService(ctx.db);
    return service.deleteSchedule(ctx.userId, input.id);
  }),

  materialize: protectedProcedure
    .input(z.object({ horizonMonths: z.number().int().min(1).max(24).default(12) }).optional())
    .mutation(async ({ ctx, input }) => {
      const service = new MaterializerService(ctx.db);
      return service.materializeForUserLocked(ctx.userId, input?.horizonMonths ?? 12);
    }),
});
