// packages/shared/src/month-ref.ts
import type { MonthRef } from './simulator.ts';

/**
 * Absolute month index for ordering/comparison: `year * 12 + month` (1-based
 * month). Strictly monotonic across calendar months, so `monthIndex(a) >=
 * monthIndex(b)` answers "is a on/after b" without any rollover handling.
 */
export const monthIndex = (ref: MonthRef): number => ref.year * 12 + ref.month;

/**
 * Add `n` calendar months to a MonthRef (negative shifts backward), with proper
 * year rollover in both directions. Computed via a 0-based absolute month so the
 * modulo math is correct for any `n`.
 */
export function addMonths(ref: MonthRef, n: number): MonthRef {
  const zero = ref.year * 12 + (ref.month - 1) + n; // 0-based absolute month
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}
