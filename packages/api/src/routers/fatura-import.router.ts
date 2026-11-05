import { z } from 'zod';
import { FaturaImportService } from '../services/fatura-import.service.ts';
import { statementParserCapabilities } from '../services/fatura-parse/pdf-validation.ts';
import { FATURA_PROFILES } from '../services/fatura-parse/profiles.ts';
import { protectedProcedure, rateLimit, router } from '../trpc.ts';
import { moneySchema } from './schemas.ts';

const MAX_BASE64_LENGTH = Math.ceil((3 * 1024 * 1024) / 3) * 4 + 4;
const MAX_MANUAL_RESPONSE_LENGTH = 1024 * 1024;
const periodSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(1000).max(9998),
});

const decisionSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('skip') }),
    z.object({
      kind: z.literal('add_expense'),
      suggestionIndex: z.number().int().min(0),
      targetCardAccountId: z.guid(),
      description: z.string().min(1).max(500),
      amount: moneySchema,
      categoryId: z.guid().optional(),
    }),
    z.object({
      kind: z.literal('add_installment'),
      suggestionIndex: z.number().int().min(0),
      targetCardAccountId: z.guid(),
      description: z.string().min(1).max(500),
      amount: moneySchema,
      totalInstallments: z.number().int().min(2).max(120),
      currentInstallmentNumber: z.number().int().min(1),
      categoryId: z.guid().optional(),
    }),
    z.object({
      kind: z.literal('add_fixed_charge'),
      suggestionIndex: z.number().int().min(0),
      targetCardAccountId: z.guid(),
      description: z.string().min(1).max(500),
      amount: moneySchema,
      categoryId: z.guid().optional(),
    }),
    z.object({
      kind: z.literal('add_refund'),
      suggestionIndex: z.number().int().min(0),
      targetCardAccountId: z.guid(),
      description: z.string().min(1).max(500),
      amount: moneySchema,
    }),
    z.object({
      kind: z.literal('update_expense'),
      transactionId: z.guid(),
      amount: moneySchema,
      description: z.string().min(1).max(500).optional(),
    }),
    z.object({
      kind: z.literal('update_schedule_amount'),
      scheduleId: z.guid(),
      amount: moneySchema,
      scope: z.enum(['cycle', 'from_cycle']).optional(),
    }),
    z.object({
      kind: z.literal('edit_installment'),
      scheduleId: z.guid(),
      description: z.string().min(1).max(500),
      amount: moneySchema,
      totalInstallments: z.number().int().min(1).max(120),
      currentInstallmentNumber: z.number().int().min(1),
      categoryId: z.guid().nullable().optional(),
    }),
    z.object({
      kind: z.literal('resolve_reversal_bundle'),
      bundleIndex: z.number().int().min(0),
      action: z.enum(['apply', 'keep']),
    }),
    z.object({
      kind: z.literal('link_statement_item'),
      suggestionIndex: z.number().int().min(0),
      transactionId: z.guid(),
    }),
    z.object({
      kind: z.literal('resolve_missing_item'),
      transactionId: z.guid(),
      action: z.enum(['keep', 'remove']),
    }),
  ])
  .superRefine((value, context) => {
    if (
      (value.kind === 'add_installment' || value.kind === 'edit_installment') &&
      value.currentInstallmentNumber > value.totalInstallments
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currentInstallmentNumber'],
        message: 'currentInstallmentNumber cannot exceed totalInstallments',
      });
    }
  });

export const faturaImportRouter = router({
  capabilities: protectedProcedure.query(() => statementParserCapabilities()),
  profiles: protectedProcedure.query(() =>
    FATURA_PROFILES.map((profile) => ({ id: profile.id, label: profile.label })),
  ),

  upload: protectedProcedure
    .use(rateLimit('faturaImport.upload'))
    .input(
      z.object({
        cardAccountId: z.guid(),
        fileName: z.string().min(1).max(255),
        pdfBase64: z.string().min(1).max(MAX_BASE64_LENGTH, 'PDF acima de 3MB'),
        externalConsent: z.literal(true),
        selectedPeriod: periodSchema.optional(),
      }),
    )
    .mutation(({ ctx, input, signal }) =>
      new FaturaImportService(ctx.db).createDraft(ctx.userId, input, signal),
    ),

  manualPrompt: protectedProcedure
    .input(z.object({ cardAccountId: z.guid() }))
    .query(({ ctx, input }) =>
      new FaturaImportService(ctx.db).getManualPrompt(ctx.userId, input.cardAccountId),
    ),

  bulkManualPrompt: protectedProcedure
    .input(z.object({ cardAccountIds: z.array(z.guid()).min(1).max(20) }))
    .query(({ ctx, input }) =>
      new FaturaImportService(ctx.db).getBulkManualPrompt(ctx.userId, input.cardAccountIds),
    ),

  uploadManual: protectedProcedure
    .use(rateLimit('faturaImport.uploadManual'))
    .input(
      z.object({
        cardAccountId: z.guid(),
        provider: z.enum(['claude', 'chatgpt', 'other']),
        responseJson: z.string().min(1).max(MAX_MANUAL_RESPONSE_LENGTH),
        selectedPeriod: periodSchema.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      new FaturaImportService(ctx.db).createManualDraft(ctx.userId, input),
    ),

  uploadManualBulk: protectedProcedure
    .use(rateLimit('faturaImport.uploadManual'))
    .input(
      z.object({
        cardAccountIds: z.array(z.guid()).min(1).max(20),
        provider: z.enum(['claude', 'chatgpt', 'other']),
        responseJson: z.string().min(1).max(MAX_MANUAL_RESPONSE_LENGTH),
      }),
    )
    .mutation(({ ctx, input }) =>
      new FaturaImportService(ctx.db).createManualBulkDrafts(ctx.userId, input),
    ),

  get: protectedProcedure
    .input(z.object({ importId: z.guid() }))
    .query(({ ctx, input }) => new FaturaImportService(ctx.db).get(ctx.userId, input.importId)),

  listByCard: protectedProcedure
    .input(z.object({ cardAccountId: z.guid() }))
    .query(({ ctx, input }) =>
      new FaturaImportService(ctx.db).listByCard(ctx.userId, input.cardAccountId),
    ),

  applyDraft: protectedProcedure
    .use(rateLimit('faturaImport.apply'))
    .input(
      z.object({
        importId: z.guid(),
        expenseAccountId: z.guid(),
        decisions: z.array(decisionSchema).max(300),
        acknowledgeTotalMismatch: z.boolean().default(false),
        reviewedPeriod: periodSchema,
      }),
    )
    .mutation(({ ctx, input }) => new FaturaImportService(ctx.db).apply(ctx.userId, input)),

  discard: protectedProcedure
    .input(z.object({ importId: z.guid() }))
    .mutation(({ ctx, input }) =>
      new FaturaImportService(ctx.db).discard(ctx.userId, input.importId),
    ),
});
