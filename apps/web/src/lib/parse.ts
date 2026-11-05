import { Money } from '@fc/domain';

/**
 * Convert a DB numeric string (or number) to a display number.
 * Routes through Money to preserve decimal precision before calling toNumber().
 * Returns 0 when the input is null/undefined/invalid — NEVER NaN.
 */
export function toDisplayNumber(val?: string | number | null): number {
  if (val == null) return 0;
  try {
    const str = typeof val === 'number' ? val.toString() : String(val);
    return Money.fromString(str, 'BRL').toNumber();
  } catch {
    return 0;
  }
}

/** @deprecated use toDisplayNumber instead */
export const safeParseFloat = toDisplayNumber;
