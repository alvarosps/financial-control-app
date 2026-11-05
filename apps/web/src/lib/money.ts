import { z } from 'zod';

/**
 * Canonical money string format expected by the API layer:
 * non-negative decimal with exactly two fractional digits (e.g. "123.45").
 */
export const moneyStringSchema = z.string().regex(/^\d+\.\d{2}$/);

/**
 * Convert a free-form form input (string from a number/text `<input>`) into
 * the canonical money string format the server expects.
 *
 * Returns `null` when the input is empty, non-numeric, or non-positive. UI
 * callers should treat `null` as an invalid input and surface a toast/error
 * before attempting to mutate — we never silently send NaN to the server.
 */
export function toMoneyInputString(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Brazilian formatting: when a comma is present it is the decimal separator
  // and dots are thousands separators ('5.180,00' -> '5180.00'). Dot-only input
  // is left untouched so plain decimals like '5.18' are not misread.
  const normalized = trimmed.includes(',') ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed;
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}
