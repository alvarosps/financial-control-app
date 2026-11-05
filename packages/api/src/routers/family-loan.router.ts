import { z } from 'zod';
import { createGuardedServices } from '../lib/service-factory.ts';
import { FamilyLoanFlowService } from '../services/family-loan-flow.service.ts';
import { protectedProcedure, router } from '../trpc.ts';
import { moneySchema, monthSchema, yearSchema } from './schemas.ts';

const editAdjustmentInput = z
  .object({
    scheduleId: z.guid(),
    description: z.string().trim().min(1).max(500),
    amount: moneySchema,
    date: z.date(),
    totalInstallments: z.number().int().positive().optional(),
    currentInstallment: z.number().int().positive().optional(),
    dueDay: z.number().int().min(1).max(31).optional(),
  })
  .superRefine((value, ctx) => {
    const installmentFields = [value.totalInstallments, value.currentInstallment, value.dueDay];
    const present = installmentFields.filter((field) => field != null).length;
    if (present !== 0 && present !== installmentFields.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Installment fields must be provided together',
      });
    }
    if (
      value.currentInstallment != null &&
      value.totalInstallments != null &&
      value.currentInstallment > value.totalInstallments
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentInstallment'],
        message: 'Current installment cannot exceed total installments',
      });
    }
    if (present === installmentFields.length && (value.totalInstallments ?? 0) < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalInstallments'],
        message: 'Installment discount must have at least 2 installments',
      });
    }
    const dateYear = value.date.getUTCFullYear();
    if (dateYear < 2020 || dateYear > 2100) {
      ctx.addIssue({
        code: 'custom',
        path: ['date'],
        message: 'Date must be between 2020 and 2100',
      });
    }
  });

export const familyLoanRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        personName: z.string().min(1).max(200),
        currency: z.string().length(3).optional(),
        notes: z.string().optional(),
        receiptDay: z.number().int().min(1).max(31).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.createFamilyLoan(ctx.userId, input);
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const { guard } = createGuardedServices(ctx.db);
    const service = new FamilyLoanFlowService(ctx.db, guard);
    return service.list(ctx.userId);
  }),

  getById: protectedProcedure
    .input(z.object({ configId: z.guid() }))
    .query(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.getById(ctx.userId, input.configId);
    }),

  update: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        personName: z.string().min(1).max(200).optional(),
        notes: z.string().nullable().optional(),
        receiptDay: z.number().int().min(1).max(31).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.update(ctx.userId, input.configId, {
        personName: input.personName,
        notes: input.notes,
        receiptDay: input.receiptDay,
      });
    }),

  deactivate: protectedProcedure
    .input(z.object({ configId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.deactivate(ctx.userId, input.configId);
    }),

  addBorrowedCard: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        creditCardAccountId: z.guid(),
        description: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.addBorrowedCard(ctx.userId, input);
    }),

  addInstallment: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        description: z.string().min(1).max(500),
        amount: moneySchema,
        totalInstallments: z.number().int().positive(),
        currentInstallment: z.number().int().min(0),
        dueDay: z.number().int().min(1).max(31),
        billingMonth: z.number().int().min(1).max(12).optional(),
        billingYear: z.number().int().min(2000).max(2100).optional(),
        categoryId: z.guid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.addInstallment(ctx.userId, input);
    }),

  editInstallment: protectedProcedure
    .input(
      z.object({
        scheduleId: z.guid(),
        description: z.string().min(1).max(500),
        amount: moneySchema,
        totalInstallments: z.number().int().positive(),
        currentInstallment: z.number().int().positive(),
        currentBillingMonth: z.number().int().min(1).max(12),
        currentBillingYear: z.number().int().min(2000).max(2100),
        categoryId: z.guid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.editInstallment(ctx.userId, input);
    }),

  editAdjustment: protectedProcedure.input(editAdjustmentInput).mutation(async ({ ctx, input }) => {
    const { guard } = createGuardedServices(ctx.db);
    const service = new FamilyLoanFlowService(ctx.db, guard);
    return service.editAdjustment(ctx.userId, input);
  }),

  addFixedCharge: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        description: z.string().min(1).max(500),
        amount: moneySchema,
        startDate: z.date(),
        dueDay: z.number().int().min(1).max(31),
        categoryId: z.guid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.addFixedCharge(ctx.userId, input);
    }),

  addOneTimeCharge: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        description: z.string().min(1).max(500),
        amount: moneySchema,
        date: z.date(),
        billingMonth: z.number().int().min(1).max(12).optional(),
        billingYear: z.number().int().min(2000).max(2100).optional(),
        categoryId: z.guid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.addOneTimeCharge(ctx.userId, input);
    }),

  addDiscount: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        description: z.string().min(1).max(500),
        amount: moneySchema,
        date: z.date(),
        totalInstallments: z.number().int().positive().optional(),
        currentInstallment: z.number().int().positive().optional(),
        dueDay: z.number().int().min(1).max(31).optional(),
        categoryId: z.guid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.addDiscount(ctx.userId, input);
    }),

  listItems: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        domainType: z.enum([
          'family_loan_installment',
          'family_loan_fixed_charge',
          'family_loan_expense',
          'family_loan_discount',
        ]),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.listItems(ctx.userId, input.configId, input.domainType);
    }),

  listWithTotals: protectedProcedure
    .input(
      z.object({
        month: monthSchema,
        year: yearSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.listWithTotals(ctx.userId, input.month, input.year);
    }),

  getMonthlyTotal: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        month: monthSchema,
        year: z.number().int().min(2020).max(2100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.getMonthlyTotal(ctx.userId, input.configId, input.month, input.year);
    }),

  get12MonthProjection: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        month: monthSchema,
        year: yearSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.get12MonthProjection(ctx.userId, input.configId, input.month, input.year);
    }),

  recordPayment: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        amount: moneySchema,
        date: z.date(),
        walletAccountId: z.guid(),
        notes: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.recordPayment(ctx.userId, input);
    }),

  reversePayment: protectedProcedure
    .input(z.object({ transactionId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.reversePayment(ctx.userId, input.transactionId);
    }),

  listPayments: protectedProcedure
    .input(z.object({ configId: z.guid() }))
    .query(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.listPayments(ctx.userId, input.configId);
    }),

  getLedger: protectedProcedure
    .input(
      z.object({
        configId: z.guid(),
        month: monthSchema,
        year: yearSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guard } = createGuardedServices(ctx.db);
      const service = new FamilyLoanFlowService(ctx.db, guard);
      return service.getLedger(ctx.userId, input.configId, {
        currentPeriod: { month: input.month, year: input.year },
      });
    }),
});
