import type { ScheduleAmountChange } from '@fc/shared';
import { Money } from './money.ts';

export function resolveScheduledAmount(
  originalAmount: string,
  changes: ScheduleAmountChange[],
  period: { billingMonth: number; billingYear: number } | null,
): string {
  if (!period) return originalAmount;
  const ordinal = period.billingYear * 12 + period.billingMonth;
  let effective = -1;
  let amount = originalAmount;
  for (const change of changes) {
    const start = change.billingYear * 12 + change.billingMonth;
    if (start <= ordinal && start > effective) {
      effective = start;
      amount = change.amount;
    }
  }
  return Money.fromString(amount, 'BRL').toDbString();
}
