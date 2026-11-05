/**
 * Normalization from user-facing installment input to the domain's canonical form.
 *
 * Users think about credit-card installments in terms of "I'm at 5/10, bill for April 2026".
 * The materializer expects a normalized series starting at occurrence 1. This function
 * translates the user view into the canonical schedule parameters:
 *   - firstBillingMonth/Year = the billing period of installment 1 (calculated backwards)
 *   - startingOccurrence is always 1 after normalization (materializer invariant)
 *
 * The returned firstBillingMonth/Year can be stored on the schedule and used directly
 * by the materializer for index-based billing assignment (see Task D2), avoiding
 * closing-day edge cases.
 */

export type NormalizeInstallmentInput = {
  currentInstallmentNumber: number;
  totalInstallments: number;
  currentBillingMonth: number; // 1..12
  currentBillingYear: number;
};

export type NormalizeInstallmentResult = {
  firstBillingMonth: number; // 1..12
  firstBillingYear: number;
};

export function normalizeInstallment(input: NormalizeInstallmentInput): NormalizeInstallmentResult {
  if (!Number.isInteger(input.totalInstallments) || input.totalInstallments < 1) {
    throw new Error(`totalInstallments must be >= 1 (got ${input.totalInstallments})`);
  }
  if (
    !Number.isInteger(input.currentInstallmentNumber) ||
    input.currentInstallmentNumber < 1 ||
    input.currentInstallmentNumber > input.totalInstallments
  ) {
    throw new Error(
      `currentInstallmentNumber must be 1..${input.totalInstallments} (got ${input.currentInstallmentNumber})`,
    );
  }
  if (
    !Number.isInteger(input.currentBillingMonth) ||
    input.currentBillingMonth < 1 ||
    input.currentBillingMonth > 12
  ) {
    throw new Error(`currentBillingMonth must be 1..12 (got ${input.currentBillingMonth})`);
  }

  // Ordinal = year*12 + (month-1); subtract (installmentNumber - 1) to step back to occurrence 1.
  const ordinal =
    input.currentBillingYear * 12 +
    (input.currentBillingMonth - 1) -
    (input.currentInstallmentNumber - 1);

  return {
    firstBillingMonth: (ordinal % 12) + 1,
    firstBillingYear: Math.floor(ordinal / 12),
  };
}
