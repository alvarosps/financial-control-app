import { addMonths, FREQUENCIES, type Frequency, type MonthRef, type SimLever } from '@fc/shared';

export type LeverKind = SimLever['kind'];

export const LEVER_KINDS: LeverKind[] = [
  'loan_payoff',
  'income_change',
  'one_time_event',
  'recurring_change',
  'savings_goal',
  'average_spend',
  'installment_growth',
  'installment_plan',
];

export const INCOME_OPS = ['add', 'adjust', 'end'] as const;
export type IncomeOp = (typeof INCOME_OPS)[number];

export const RECURRING_OPS = ['add', 'cancel'] as const;
export type RecurringOp = (typeof RECURRING_OPS)[number];

export const EVENT_SIGNS = ['inflow', 'outflow'] as const;
export type EventSign = (typeof EVENT_SIGNS)[number];

export const SELECTABLE_FREQUENCIES: readonly Frequency[] = FREQUENCIES;

export const HORIZON_OPTIONS = [3, 6, 12, 24, 36] as const;
export type HorizonOption = (typeof HORIZON_OPTIONS)[number];

/** The current calendar month as a 1-based {@link MonthRef}. */
export function currentMonth(): MonthRef {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

/** The month after the current one, rolling Dec over into the next January. */
export function nextMonth(): MonthRef {
  return addMonths(currentMonth(), 1);
}

/**
 * Shared props every per-kind lever editor accepts. `value` is the lever being
 * edited (or `null` when adding a fresh one). `onSubmit` emits the validated
 * lever (carrying a stable `id`); `onCancel` dismisses without changes.
 */
export type LeverEditorProps = {
  value: SimLever | null;
  onSubmit: (lever: SimLever) => void;
  onCancel: () => void;
};

/** Stable id for a lever: reuse the edited one, otherwise mint a fresh uuid. */
export function leverEditorId(value: SimLever | null): string {
  return value?.id ?? crypto.randomUUID();
}

/** i18n key for a lever kind label, e.g. simulator.leverKind.loan_payoff. */
export function leverKindKey(kind: LeverKind): string {
  return `simulator.leverKind.${kind}`;
}

/** Short human summary line for a lever card; falls back to its kind. */
export function leverLabel(lever: SimLever): string {
  if ('label' in lever && lever.label) return lever.label;
  return lever.kind;
}
