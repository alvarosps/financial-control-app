import type { ComponentType } from 'react';
import { AverageSpendLeverEditor } from './AverageSpendLeverEditor';
import { IncomeLeverEditor } from './IncomeLeverEditor';
import { InstallmentGrowthLeverEditor } from './InstallmentGrowthLeverEditor';
import { InstallmentPlanLeverEditor } from './InstallmentPlanLeverEditor';
import { LoanPayoffLeverEditor } from './LoanPayoffLeverEditor';
import type { LeverEditorProps, LeverKind } from './lever-options';
import { OneTimeEventLeverEditor } from './OneTimeEventLeverEditor';
import { RecurringLeverEditor } from './RecurringLeverEditor';
import { SavingsGoalLeverEditor } from './SavingsGoalLeverEditor';

/**
 * Maps each lever kind to its per-kind editor component, replacing the
 * `editor.kind === '...' && <XEditor />` dispatch ladder in `LeverPanel`. This
 * registry imports the editors (which transitively import `lever-options`), so
 * it must NOT live in `lever-options` itself — that would create an import
 * cycle (`lever-options` → editor → `lever-options`).
 */
export const LEVER_EDITORS: Record<LeverKind, ComponentType<LeverEditorProps>> = {
  loan_payoff: LoanPayoffLeverEditor,
  income_change: IncomeLeverEditor,
  one_time_event: OneTimeEventLeverEditor,
  recurring_change: RecurringLeverEditor,
  savings_goal: SavingsGoalLeverEditor,
  average_spend: AverageSpendLeverEditor,
  installment_growth: InstallmentGrowthLeverEditor,
  installment_plan: InstallmentPlanLeverEditor,
};
