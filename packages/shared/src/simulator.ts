// packages/shared/src/simulator.ts
import type { Frequency } from './enums.ts';

/** A calendar month, 1-based month index. */
export type MonthRef = { month: number; year: number };

/**
 * A single "what-if" adjustment applied on top of the baseline projection.
 * Each variant is discriminated by `kind` and carries its own `id` (stable
 * across edits) plus a human `label` where the lever is shown as an event.
 */
export type SimLever =
  | {
      kind: 'loan_payoff';
      id: string;
      loanAccountId: string;
      targetMonth: MonthRef;
      partialAmount?: string;
    }
  | {
      kind: 'income_change';
      id: string;
      op: 'add' | 'adjust' | 'end';
      amount?: string;
      percent?: number;
      frequency: Frequency;
      fromMonth: MonthRef;
      toMonth?: MonthRef;
      label: string;
    }
  | {
      kind: 'one_time_event';
      id: string;
      sign: 'inflow' | 'outflow';
      amount: string;
      month: MonthRef;
      label: string;
    }
  | {
      kind: 'recurring_change';
      id: string;
      op: 'add' | 'cancel';
      scheduledTransactionId?: string;
      amount?: string;
      frequency?: Frequency;
      startMonth?: MonthRef;
      endMonth?: MonthRef;
      label: string;
    }
  | {
      kind: 'savings_goal';
      id: string;
      target: string;
      byMonth: MonthRef;
      label: string;
    }
  | {
      kind: 'average_spend';
      id: string;
      amount: string;
      fromMonth: MonthRef;
      label: string;
    }
  | {
      kind: 'installment_growth';
      id: string;
      monthlyAmount: string;
      /**
       * Lifetime (in months) of EACH installment spawned per month. When set,
       * an installment started at month s runs `[s, s + termMonths − 1]`, so the
       * burden grows to `monthlyAmount × termMonths` and then holds steady
       * (rolling window). When omitted, every installment runs to the horizon end
       * (perpetual linear accumulation — the original behavior).
       */
      termMonths?: number;
      fromMonth: MonthRef;
      label: string;
    }
  | {
      kind: 'installment_plan';
      id: string;
      amount: string; // per-parcela monthly amount (BRL)
      installments: number; // term count N (>= 1)
      startMonth: MonthRef;
      label: string;
    };

/**
 * A historical month excluded from the typical spend average, with the
 * reason(s) it was treated as an outlier (statistical = far from the median,
 * iof = contains foreign-currency IOF charges that skew the month).
 */
export type SpendOutlierMonth = {
  month: number;
  year: number;
  total: string;
  reasons: Array<'statistical' | 'iof'>;
};

/**
 * Historical spend averages derived from the user's last recorded (complete)
 * months. Read-only; feeds the default values for the `average_spend` and
 * `installment_growth` lever editors. All amounts are BRL money strings.
 */
export type MonthlyAverages = {
  window: number;
  monthsWithData: number;
  monthsUsed: number;
  averageMonthlySpend: string; // typical mean (outliers excluded)
  rawAverageMonthlySpend: string; // mean incl. outliers (transparency)
  averageNewInstallment: string;
  byCategory: { creditCard: string; loan: string; charge: string; other: string };
  excludedMonths: SpendOutlierMonth[];
};

/**
 * A suggested installment plan derived from recent recurring purchases —
 * the default values offered when adding an `installment_plan` lever.
 */
export type InstallmentSuggestion = {
  label: string;
  amount: string;
  installments: number;
};

/**
 * A persisted simulation scenario. `parameters` column on `simulation_scenarios`
 * stores this exact shape (zod-validated at the tRPC router boundary).
 */
export type SimAssumptions = {
  familyReceiptPercent: number;
  exchangeRates?: Record<string, string>;
};

export type SimScenario = {
  version?: 2;
  assumptions?: SimAssumptions;
  name: string;
  openingBalanceOverride?: string;
  horizon: number;
  levers: SimLever[];
};
