import { FREQUENCIES } from '@fc/shared';
import { z } from 'zod';

const moneyString = z.string().regex(/^-?\d+\.\d{2}$/, 'Amount must be a 2-decimal money string');
const frequency = z.enum(FREQUENCIES);
const monthRef = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
});

const loanPayoffLever = z.object({
  kind: z.literal('loan_payoff'),
  id: z.string(),
  loanAccountId: z.guid(),
  targetMonth: monthRef,
  partialAmount: moneyString.optional(),
});

const incomeChangeLever = z.object({
  kind: z.literal('income_change'),
  id: z.string(),
  op: z.enum(['add', 'adjust', 'end']),
  amount: moneyString.optional(),
  percent: z.number().optional(),
  frequency,
  fromMonth: monthRef,
  toMonth: monthRef.optional(),
  label: z.string().min(1).max(200),
});

const oneTimeEventLever = z.object({
  kind: z.literal('one_time_event'),
  id: z.string(),
  sign: z.enum(['inflow', 'outflow']),
  amount: moneyString,
  month: monthRef,
  label: z.string().min(1).max(200),
});

const recurringChangeLever = z.object({
  kind: z.literal('recurring_change'),
  id: z.string(),
  op: z.enum(['add', 'cancel']),
  scheduledTransactionId: z.guid().optional(),
  amount: moneyString.optional(),
  frequency: frequency.optional(),
  startMonth: monthRef.optional(),
  endMonth: monthRef.optional(),
  label: z.string().min(1).max(200),
});

const savingsGoalLever = z.object({
  kind: z.literal('savings_goal'),
  id: z.string(),
  target: moneyString,
  byMonth: monthRef,
  label: z.string().min(1).max(200),
});

const averageSpendLever = z.object({
  kind: z.literal('average_spend'),
  id: z.string(),
  amount: moneyString,
  fromMonth: monthRef,
  label: z.string().min(1).max(200),
});

const installmentGrowthLever = z.object({
  kind: z.literal('installment_growth'),
  id: z.string(),
  monthlyAmount: moneyString,
  termMonths: z.number().int().min(1).optional(),
  fromMonth: monthRef,
  label: z.string().min(1).max(200),
});

const installmentPlanLever = z.object({
  kind: z.literal('installment_plan'),
  id: z.string(),
  amount: moneyString,
  installments: z.number().int().min(1),
  startMonth: monthRef,
  label: z.string().min(1).max(200),
});

/**
 * Per-op cross-field validation. The lever object schemas keep every
 * conditional field `.optional()` so the discriminated union can carry plain
 * `ZodObject` members (zod's `discriminatedUnion` rejects refined `ZodEffects`
 * members). The structural-vs-op requirements are enforced here, on the union
 * result, switching on `kind` — each rule mirrors what the matching resolver
 * actually reads:
 *  - income_change `add`/`end` read `amount` (`resolve-income-change.ts`); `end`
 *    negates it. `adjust` reads BOTH `amount` (the base the percentage applies
 *    to) and `percent` — without `amount` the contribution `amount * percent/100`
 *    is 0 and the lever silently no-ops, so both are required.
 *  - recurring_change `add` reads `amount` + `frequency`; `cancel` reads
 *    `scheduledTransactionId` (`resolve-recurring-change.ts`).
 */
export const simLeverSchema = z
  .discriminatedUnion('kind', [
    loanPayoffLever,
    incomeChangeLever,
    oneTimeEventLever,
    recurringChangeLever,
    savingsGoalLever,
    averageSpendLever,
    installmentGrowthLever,
    installmentPlanLever,
  ])
  .superRefine((lever, ctx) => {
    if (lever.kind === 'income_change') {
      if (lever.op === 'adjust') {
        if (lever.percent == null) {
          ctx.addIssue({
            code: 'custom',
            path: ['percent'],
            message: "income_change op 'adjust' requires percent",
          });
        }
        // `adjust` computes `amount * (percent/100)`; without `amount` the
        // contribution is 0 and the lever silently no-ops, so it is required too.
        if (lever.amount == null) {
          ctx.addIssue({
            code: 'custom',
            path: ['amount'],
            message: "income_change op 'adjust' requires amount",
          });
        }
      }
      if ((lever.op === 'add' || lever.op === 'end') && lever.amount == null) {
        ctx.addIssue({
          code: 'custom',
          path: ['amount'],
          message: `income_change op '${lever.op}' requires amount`,
        });
      }
      return;
    }
    if (lever.kind === 'recurring_change') {
      if (lever.op === 'add') {
        if (lever.amount == null) {
          ctx.addIssue({
            code: 'custom',
            path: ['amount'],
            message: "recurring_change op 'add' requires amount",
          });
        }
        if (lever.frequency == null) {
          ctx.addIssue({
            code: 'custom',
            path: ['frequency'],
            message: "recurring_change op 'add' requires frequency",
          });
        }
      }
      if (lever.op === 'cancel' && lever.scheduledTransactionId == null) {
        ctx.addIssue({
          code: 'custom',
          path: ['scheduledTransactionId'],
          message: "recurring_change op 'cancel' requires scheduledTransactionId",
        });
      }
    }
  });

export const simAssumptionsSchema = z.object({
  familyReceiptPercent: z.number().finite().min(0).max(100).default(100),
  exchangeRates: z
    .partialRecord(
      z.enum(['USD', 'EUR', 'GBP']),
      z
        .string()
        .regex(/^\d+(\.\d{1,6})?$/)
        .refine((value) => Number(value) > 0 && Number(value) <= 10000),
    )
    .optional(),
});

export const simScenarioSchema = z.object({
  version: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .transform(() => 2 as const),
  assumptions: simAssumptionsSchema.default({ familyReceiptPercent: 100 }),
  name: z.string().min(1).max(200),
  openingBalanceOverride: moneyString.optional(),
  horizon: z.number().int().min(1).max(36),
  levers: z.array(simLeverSchema),
});
