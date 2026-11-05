import { accounts, creditCardConfigs } from '@fc/db';
import { isCalendarDate } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createGuardedServices } from '../lib/service-factory.ts';
import { BillService } from '../services/bill.service.ts';
import { CreditCardFlowService } from '../services/credit-card-flow.service.ts';
import { CreditCardLifecycleService } from '../services/credit-card-lifecycle.service.ts';
import { FATURA_PROFILE_IDS } from '../services/fatura-parse/profiles.ts';
import { protectedProcedure, rateLimit, router } from '../trpc.ts';
import { moneySchema, monthSchema, yearSchema } from './schemas.ts';

const knownCalendarDate = z
  .union([z.string().refine(isCalendarDate), z.date()])
  .nullable()
  .optional();

export const creditCardRouter = router({
  listArchivedGroups: protectedProcedure.query(async ({ ctx }) => {
    return new CreditCardLifecycleService(ctx.db).listArchivedGroups(ctx.userId);
  }),

  archiveGroup: protectedProcedure
    .input(z.object({ cardAccountId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      return new CreditCardLifecycleService(ctx.db).archiveGroup(ctx.userId, input.cardAccountId);
    }),

  reactivateGroup: protectedProcedure
    .input(z.object({ cardAccountId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      return new CreditCardLifecycleService(ctx.db).reactivateGroup(
        ctx.userId,
        input.cardAccountId,
      );
    }),

  getConfig: protectedProcedure
    .input(z.object({ accountId: z.guid() }))
    .query(async ({ ctx, input }) => {
      const [account] = await ctx.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, input.accountId));

      if (!account || account.userId !== ctx.userId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
      }

      const [config] = await ctx.db
        .select()
        .from(creditCardConfigs)
        .where(eq(creditCardConfigs.accountId, input.accountId));

      return config ?? null;
    }),

  upsertConfig: protectedProcedure
    .input(
      z.object({
        accountId: z.guid(),
        closingDay: z.number().int().min(1).max(31),
        dueDay: z.number().int().min(1).max(31),
        creditLimit: moneySchema.optional(),
        billParserType: z
          .string()
          .refine(
            (value) => FATURA_PROFILE_IDS.some((profileId) => profileId === value),
            'perfil de fatura desconhecido',
          )
          .optional(),
        isDueDayVariable: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new CreditCardFlowService(ctx.db);
      return service.upsertConfig(ctx.userId, input);
    }),

  listConfigs: protectedProcedure.query(async ({ ctx }) => {
    const service = new CreditCardFlowService(ctx.db);
    return service.listConfigs(ctx.userId);
  }),

  getBill: protectedProcedure
    .input(
      z.object({
        cardAccountId: z.guid(),
        month: monthSchema,
        year: yearSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new BillService(ctx.db, guard);
      return service.getBill(ctx.userId, input.cardAccountId, input.month, input.year);
    }),

  getBillSummary: protectedProcedure.query(async ({ ctx }) => {
    const { guard } = createGuardedServices(ctx.db);
    const service = new BillService(ctx.db, guard);
    return service.getBillSummary(ctx.userId);
  }),

  getConsolidatedBill: protectedProcedure
    .input(
      z.object({
        cardAccountId: z.guid(),
        month: monthSchema,
        year: yearSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new BillService(ctx.db, guard);
      return service.getConsolidatedBill(ctx.userId, input.cardAccountId, input.month, input.year);
    }),

  getBillHistory: protectedProcedure
    .input(
      z.object({
        cardAccountId: z.guid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new BillService(ctx.db, guard);
      return service.getBillHistory(ctx.userId, input.cardAccountId);
    }),

  payBill: protectedProcedure
    .use(rateLimit('bill.pay'))
    .input(
      z.object({
        cardAccountId: z.guid(),
        month: monthSchema,
        year: yearSchema,
        paidFromAccountId: z.guid(),
        settlementDate: z.date().optional(),
        expectedAmount: moneySchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new BillService(ctx.db, guard);
      return service.payBill(
        ctx.userId,
        input.cardAccountId,
        input.month,
        input.year,
        input.paidFromAccountId,
        input.settlementDate,
        input.expectedAmount,
      );
    }),

  addInstallment: protectedProcedure
    .input(
      z
        .object({
          creditCardAccountId: z.guid(),
          expenseAccountId: z.guid(),
          description: z.string().min(1).max(500),
          amount: moneySchema,
          totalInstallments: z.number().int().min(1).max(120),
          currentInstallmentNumber: z.number().int().min(1),
          currentBillingMonth: monthSchema,
          currentBillingYear: yearSchema,
          categoryId: z.guid().optional(),
          purchaseDate: knownCalendarDate,
        })
        .refine((v) => v.currentInstallmentNumber <= v.totalInstallments, {
          message: 'currentInstallmentNumber cannot exceed totalInstallments',
          path: ['currentInstallmentNumber'],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new CreditCardFlowService(ctx.db);
      return service.addInstallment(ctx.userId, input);
    }),

  editInstallment: protectedProcedure
    .input(
      z
        .object({
          scheduleId: z.guid(),
          description: z.string().min(1).max(500),
          amount: moneySchema,
          totalInstallments: z.number().int().min(1).max(120),
          currentInstallmentNumber: z.number().int().min(1),
          currentBillingMonth: monthSchema,
          currentBillingYear: yearSchema,
          categoryId: z.guid().nullable().optional(),
        })
        .refine((v) => v.currentInstallmentNumber <= v.totalInstallments, {
          message: 'currentInstallmentNumber cannot exceed totalInstallments',
          path: ['currentInstallmentNumber'],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new CreditCardFlowService(ctx.db);
      return service.editInstallment(ctx.userId, input);
    }),

  addOneTimeExpense: protectedProcedure
    .input(
      z.object({
        creditCardAccountId: z.guid(),
        expenseAccountId: z.guid(),
        description: z.string().min(1).max(500),
        amount: moneySchema,
        billingMonth: monthSchema,
        billingYear: yearSchema,
        purchaseDate: knownCalendarDate,
        postedDate: knownCalendarDate,
        categoryId: z.guid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new CreditCardFlowService(ctx.db);
      return service.addOneTimeExpense(ctx.userId, input);
    }),

  addRefund: protectedProcedure
    .input(
      z.object({
        creditCardAccountId: z.guid(),
        expenseAccountId: z.guid(),
        description: z.string().min(1).max(500),
        amount: moneySchema,
        billingMonth: monthSchema,
        billingYear: yearSchema,
        refundDate: z.date().optional(),
        purchaseDate: knownCalendarDate,
        postedDate: knownCalendarDate,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new CreditCardFlowService(ctx.db);
      return service.addRefund(ctx.userId, input);
    }),

  addFixedCharge: protectedProcedure
    .input(
      z.object({
        creditCardAccountId: z.guid(),
        expenseAccountId: z.guid(),
        description: z.string().min(1).max(500),
        amount: moneySchema,
        dueDay: z.number().int().min(1).max(31),
        startDate: z.date(),
        firstBillingMonth: monthSchema.optional(),
        firstBillingYear: yearSchema.optional(),
        categoryId: z.guid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new CreditCardFlowService(ctx.db);
      return service.addFixedCharge(ctx.userId, input);
    }),
});
