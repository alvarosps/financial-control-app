import { Money } from '@fc/domain';
import { z } from 'zod';

export const purchaseDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  );
export const purchaseAmountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/)
  .refine((value) => !Money.fromString(value, 'BRL').isZero())
  .transform((value) => Money.fromString(value, 'BRL').toDbString());
export const financialEventDataSchema = z
  .object({
    cardAccountId: z.guid().nullable(),
    description: z.string().trim().min(1).max(200),
    amount: purchaseAmountSchema,
    currency: z.enum(['BRL', 'USD', 'EUR', 'GBP']),
    amountMeaning: z.enum(['purchase_total', 'installment', 'unknown']),
    kind: z.enum(['purchase', 'refund']),
    purchaseDate: purchaseDaySchema.nullable(),
    postedDate: purchaseDaySchema.nullable(),
    installmentNumber: z.number().int().min(1).max(120).nullable(),
    totalInstallments: z.number().int().min(1).max(120).nullable(),
    confirmation: z.enum(['observed', 'pending', 'posted', 'retracted']),
  })
  .strict();
export const ingestFinancialEventSchema = z
  .object({
    source: z.enum(['manual', 'pdf', 'android', 'pluggy']),
    sourceScope: z.string().min(1).max(128),
    externalId: z.string().min(1).max(200),
    sourceVersion: z.number().int().min(1).max(2147483647),
    parserVersion: z.string().min(1).max(80),
    observedAt: z.date(),
    data: financialEventDataSchema,
  })
  .strict()
  .refine(
    ({ data }) =>
      (data.installmentNumber === null && data.totalInstallments === null) ||
      (data.installmentNumber !== null &&
        data.totalInstallments !== null &&
        data.installmentNumber <= data.totalInstallments),
  );
export type IngestFinancialEventInput = z.input<typeof ingestFinancialEventSchema>;
export const purchaseVersionSchema = z.object({
  observationId: z.guid(),
  version: z.number().int().positive(),
});
export const purchaseTargetSchema = z.union([
  z.object({ transactionId: z.guid() }).strict(),
  z
    .object({
      scheduleId: z.guid(),
      billingMonth: z.number().int().min(1).max(12).optional(),
      billingYear: z.number().int().min(2000).max(2200).optional(),
    })
    .strict()
    .refine((v) => (v.billingMonth === undefined) === (v.billingYear === undefined)),
]);
export type PurchaseTarget = z.infer<typeof purchaseTargetSchema>;

export const purchaseListSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.guid().optional(),
    cardAccountId: z.guid().optional(),
    review: z.enum(['unreviewed', 'needs_review', 'accepted', 'ignored']).optional(),
    fromDate: purchaseDaySchema.optional(),
    toDate: purchaseDaySchema.optional(),
    unknownDate: z.boolean().optional(),
  })
  .strict();
export const purchaseReviewSchema = purchaseVersionSchema
  .extend({
    changes: financialEventDataSchema
      .omit({ confirmation: true })
      .partial()
      .extend({
        categoryId: z.guid().nullable().optional(),
        unrecognized: z.boolean().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0),
  })
  .strict();
export const purchaseAcceptSchema = purchaseVersionSchema
  .extend({
    expenseAccountId: z.guid(),
    billingMonth: z.number().int().min(1).max(12),
    billingYear: z.number().int().min(2000).max(2200),
    confirmDistinct: z.boolean().default(false),
  })
  .strict();
export const purchaseLinkSchema = purchaseVersionSchema
  .extend({ target: purchaseTargetSchema })
  .strict();
export const purchaseSeparateEvidenceSchema = purchaseVersionSchema
  .extend({ eventId: z.guid() })
  .strict();
