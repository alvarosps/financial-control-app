import { z } from 'zod';

export const pluggyId = z.guid();
const amount = z.number().finite().min(-999_999_999_999).max(999_999_999_999);
const currency = z.string().regex(/^[A-Z]{3}$/);
const date = z
  .string()
  .max(40)
  .refine((value) => {
    const day = value.slice(0, 10);
    return (
      /^\d{4}-\d{2}-\d{2}(T.+)?$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
    );
  });

export const pluggyItemSchema = z.object({
  id: pluggyId,
  status: z.string().min(1).max(80),
  connector: z.object({ id: z.number().int().positive(), name: z.string().max(200) }),
  lastUpdatedAt: date.nullish(),
  executionStatus: z.string().max(80).nullish(),
});
export const pluggyAccountSchema = z.object({
  id: pluggyId,
  itemId: pluggyId,
  type: z.enum(['BANK', 'CREDIT']),
  subtype: z.string().max(80).nullish(),
  name: z.string().max(200),
  currencyCode: currency,
  balance: amount,
});
export const pluggyTransactionSchema = z.object({
  id: pluggyId,
  accountId: pluggyId,
  description: z.string().min(1).max(1000),
  amount,
  amountInAccountCurrency: amount.nullish(),
  currencyCode: currency,
  date,
  createdAt: date,
  updatedAt: date,
  type: z.enum(['DEBIT', 'CREDIT']).nullish(),
  status: z.enum(['POSTED', 'PENDING']).nullish(),
  providerId: z.string().max(300).nullish(),
  operationType: z.string().max(100).nullish(),
  creditCardMetadata: z
    .object({
      cardNumber: z
        .string()
        .max(40)
        .transform((value) => value.replace(/\D/g, '').slice(-4))
        .nullish(),
      installmentNumber: z.number().int().min(1).max(120).nullish(),
      totalInstallments: z.number().int().min(1).max(120).nullish(),
      totalAmount: amount.nullish(),
      purchaseDate: date.nullish(),
      billId: pluggyId.nullish(),
      billForecastDate: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .nullish(),
    })
    .nullish(),
});
export const pluggyBillSchema = z.object({
  id: pluggyId,
  dueDate: date.nullish(),
  billClosingDate: date.nullish(),
  totalAmount: amount,
  totalAmountCurrencyCode: currency,
});
export const pluggyTransactionFiltersSchema = z
  .object({
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
    createdAtFrom: z.string().datetime({ offset: true }).optional(),
    ids: z.array(pluggyId).min(1).max(500).optional(),
  })
  .strict()
  .refine((value) => !(value.dateFrom && value.createdAtFrom));
export const pluggyTransactionPageSchema = z.object({
  results: z.array(pluggyTransactionSchema).max(500),
  next: z.string().min(1).max(16_384).nullable(),
});
export type PluggyItem = z.infer<typeof pluggyItemSchema>;
export type PluggyAccount = z.infer<typeof pluggyAccountSchema>;
export type PluggyTransaction = z.infer<typeof pluggyTransactionSchema>;
export type PluggyBill = z.infer<typeof pluggyBillSchema>;
export type PluggyTransactionFilters = z.infer<typeof pluggyTransactionFiltersSchema>;
export type PluggyTransactionPage = z.infer<typeof pluggyTransactionPageSchema>;
