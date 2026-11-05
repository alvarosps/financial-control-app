import { Money } from '@fc/domain';
import Decimal from 'decimal.js';
import { z } from 'zod';

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const date = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
  });
const source = z.string().trim().min(1).max(200);
export const loanCostEvidenceSchema = z.object({
  annualCet: z
    .object({
      rate: z
        .string()
        .regex(/^\d{1,2}\.\d{1,8}$/)
        .refine((v) => new Decimal(v).gte(0)),
      source,
      observedOn: calendarDate,
    })
    .nullable()
    .optional(),
  payoffQuote: z
    .object({
      amount: z
        .string()
        .regex(/^\d{1,10}\.\d{2}$/)
        .refine((v) => Money.fromString(v, 'BRL').isPositive()),
      quotedOn: calendarDate,
      validUntil: calendarDate,
      source,
    })
    .refine((v) => v.validUntil >= v.quotedOn, 'Quote validity precedes issue date')
    .nullable()
    .optional(),
  economicResponsibility: z.enum(['unknown', 'own', 'family', 'work', 'property']).optional(),
});
