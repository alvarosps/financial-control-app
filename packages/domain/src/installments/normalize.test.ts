import { describe, expect, it } from 'vitest';
import { normalizeInstallment } from './normalize.ts';

describe('normalizeInstallment', () => {
  it('5/10 in Apr/2026 → first = Dec/2025', () => {
    expect(
      normalizeInstallment({
        currentInstallmentNumber: 5,
        totalInstallments: 10,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      }),
    ).toEqual({ firstBillingMonth: 12, firstBillingYear: 2025 });
  });

  it('1/10 in Apr/2026 → first = Apr/2026', () => {
    expect(
      normalizeInstallment({
        currentInstallmentNumber: 1,
        totalInstallments: 10,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      }),
    ).toEqual({ firstBillingMonth: 4, firstBillingYear: 2026 });
  });

  it('12/12 in Jan/2026 → first = Feb/2025', () => {
    expect(
      normalizeInstallment({
        currentInstallmentNumber: 12,
        totalInstallments: 12,
        currentBillingMonth: 1,
        currentBillingYear: 2026,
      }),
    ).toEqual({ firstBillingMonth: 2, firstBillingYear: 2025 });
  });

  it('3/12 in Feb/2026 → first = Dec/2025 (crosses year)', () => {
    expect(
      normalizeInstallment({
        currentInstallmentNumber: 3,
        totalInstallments: 12,
        currentBillingMonth: 2,
        currentBillingYear: 2026,
      }),
    ).toEqual({ firstBillingMonth: 12, firstBillingYear: 2025 });
  });

  it('10/10 in Dec/2026 → first = Mar/2026', () => {
    expect(
      normalizeInstallment({
        currentInstallmentNumber: 10,
        totalInstallments: 10,
        currentBillingMonth: 12,
        currentBillingYear: 2026,
      }),
    ).toEqual({ firstBillingMonth: 3, firstBillingYear: 2026 });
  });

  it('throws when currentInstallmentNumber is 0', () => {
    expect(() =>
      normalizeInstallment({
        currentInstallmentNumber: 0,
        totalInstallments: 10,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      }),
    ).toThrow(/currentInstallmentNumber must be/);
  });

  it('throws when currentInstallmentNumber exceeds totalInstallments', () => {
    expect(() =>
      normalizeInstallment({
        currentInstallmentNumber: 11,
        totalInstallments: 10,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      }),
    ).toThrow(/currentInstallmentNumber must be/);
  });

  it('throws when currentBillingMonth is out of 1..12', () => {
    expect(() =>
      normalizeInstallment({
        currentInstallmentNumber: 1,
        totalInstallments: 10,
        currentBillingMonth: 13,
        currentBillingYear: 2026,
      }),
    ).toThrow(/currentBillingMonth must be/);
  });

  it('throws when totalInstallments is 0', () => {
    expect(() =>
      normalizeInstallment({
        currentInstallmentNumber: 1,
        totalInstallments: 0,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      }),
    ).toThrow(/totalInstallments must be/);
  });
});
