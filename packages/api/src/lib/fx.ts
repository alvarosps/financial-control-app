import { Money } from '@fc/domain';

/**
 * Convert a foreign-currency amount to BRL.
 *
 * - BRL amounts are returned unchanged (no rate needed — the common case).
 * - For any other currency, the rate is resolved as `perTxRate ?? configRate`.
 *   A missing rate (null/undefined), a non-numeric rate, or a rate `<= 0`
 *   THROWS rather than silently defaulting to 1:1, which would corrupt totals
 *   (e.g. 1000 USD counted as R$1000).
 */
export function convertToBrl(
  amount: Money,
  currency: string,
  perTxRate: string | null | undefined,
  configRate: string | null | undefined,
): Money {
  if (currency === 'BRL') return amount;

  const rate = perTxRate ?? configRate;
  const numericRate = rate == null ? Number.NaN : Number(rate);
  if (!Number.isFinite(numericRate) || numericRate <= 0) {
    throw new Error(`No valid exchange rate for ${currency} income; set a positive rate`);
  }

  return Money.fromString(amount.multiply(numericRate).toDbString(), 'BRL');
}

/**
 * Convert foreign-currency income to BRL, net of a conversion fee.
 *
 * Income from USD sources (e.g. Inscyth via Husky) loses a percentage to a
 * conversion fee. Net BRL = gross × (1 − feePercent/100).
 *
 * - BRL amounts are returned as-is. Realized cash is resolved before this
 *   helper, preserving the original foreign amount without another fee.
 * - A missing, non-numeric, zero, or negative fee means a plain conversion.
 * - Rate validation is delegated to `convertToBrl` (throws on a missing rate
 *   for a non-BRL currency).
 */
export function convertIncomeToBrl(
  amount: Money,
  currency: string,
  perTxRate: string | null | undefined,
  configRate: string | null | undefined,
  feePercent: string | number | null | undefined,
): Money {
  const gross = convertToBrl(amount, currency, perTxRate, configRate);
  if (currency === 'BRL') return gross;
  const fee = feePercent == null ? 0 : Number(feePercent);
  if (!Number.isFinite(fee) || fee <= 0) return gross;
  return gross.multiply(Math.max(0, 1 - fee / 100));
}
