import { describe, expect, it } from 'vitest';
import type { ParsedCard } from './types.ts';
import {
  computeParsedTotals,
  FaturaValidationError,
  flattenParsedCards,
  resolveBillingFromDueDate,
  totalsDelta,
  validateStatementImportPeriod,
} from './validate.ts';

const CONFIG = { closingDay: 8, dueDay: 15 };

describe('resolveBillingFromDueDate', () => {
  it('derives billing month and year from a due date in the current month', () => {
    expect(resolveBillingFromDueDate('2026-07-15', CONFIG)).toMatchObject({
      billingMonth: 7,
      billingYear: 2026,
    });
  });

  it('accepts past and future months without reading a clock', () => {
    expect(resolveBillingFromDueDate('2026-05-15', CONFIG)).toMatchObject({ billingMonth: 5 });
    expect(resolveBillingFromDueDate('2026-08-15', CONFIG)).toMatchObject({ billingMonth: 8 });
    expect(resolveBillingFromDueDate('2026-09-08', { closingDay: 24, dueDay: 8 })).toMatchObject({
      billingMonth: 8,
      confidence: 'estimated',
    });
  });

  it('rejects malformed and impossible calendar dates', () => {
    for (const value of ['15/07/2026', '2026-02-31', '2026-00-10']) {
      try {
        resolveBillingFromDueDate(value, CONFIG);
        throw new Error('expected validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(FaturaValidationError);
        expect((error as FaturaValidationError).code).toBe('invalid_due_date');
      }
    }
  });
});

describe('validateStatementImportPeriod', () => {
  const cycle = { billingMonth: 8, billingYear: 2026, confidence: 'estimated' as const };
  it('requires the reviewer to confirm the same closing period', () => {
    expect(() =>
      validateStatementImportPeriod({
        cycle,
        selectedPeriod: null,
        closed: false,
        today: '2026-07-10',
      }),
    ).toThrow('statement.periodReviewRequired');
    expect(() =>
      validateStatementImportPeriod({
        cycle,
        selectedPeriod: { month: 9, year: 2026 },
        closed: false,
        today: '2026-07-10',
      }),
    ).toThrow('statement.cycleConflict');
  });
  it('blocks a closed month even after review', () => {
    expect(() =>
      validateStatementImportPeriod({
        cycle,
        selectedPeriod: { month: 8, year: 2026 },
        closed: true,
        today: '2026-07-10',
      }),
    ).toThrow('statement.monthClosed');
  });
  it('identifies future estimates and permits reviewed historical imports', () => {
    expect(
      validateStatementImportPeriod({
        cycle,
        selectedPeriod: { month: 8, year: 2026 },
        closed: false,
        today: '2026-07-10',
      }),
    ).toEqual({ future: true, estimated: true });
    expect(
      validateStatementImportPeriod({
        cycle,
        selectedPeriod: { month: 8, year: 2026 },
        closed: false,
        today: '2026-09-10',
      }),
    ).toEqual({ future: false, estimated: true });
  });
});

describe('flattenParsedCards', () => {
  it('flattens cards while stamping card metadata on each item', () => {
    const cards: ParsedCard[] = [
      {
        lastFour: '9859',
        holderName: 'ALVARO SOUZA',
        isAdditional: false,
        items: [
          {
            description: 'PANVEL MATRIZ',
            amountBRL: '68.96',
            purchaseDate: '2025-12-23',
            installmentCurrent: 5,
            installmentTotal: 5,
            isRefund: false,
          },
        ],
      },
      {
        lastFour: '8516',
        holderName: 'CAMILA STEINMETZ',
        isAdditional: true,
        items: [
          {
            description: 'SEPHORA',
            amountBRL: '288.42',
            purchaseDate: null,
            installmentCurrent: 2,
            installmentTotal: 12,
            isRefund: false,
          },
        ],
      },
    ];
    const flattened = flattenParsedCards(cards);
    expect(flattened).toHaveLength(2);
    expect(flattened[0]?.cardLastFour).toBe('9859');
    expect(flattened[1]).toMatchObject({
      holderName: 'CAMILA STEINMETZ',
      isAdditional: true,
    });
  });
});

describe('statement totals', () => {
  it('sums charges and refunds with decimal precision', () => {
    const items = flattenParsedCards([
      {
        lastFour: null,
        holderName: null,
        isAdditional: false,
        items: [
          {
            description: 'A',
            amountBRL: '1234.56',
            purchaseDate: null,
            installmentCurrent: null,
            installmentTotal: null,
            isRefund: false,
          },
          {
            description: 'B',
            amountBRL: '25.90',
            purchaseDate: null,
            installmentCurrent: null,
            installmentTotal: null,
            isRefund: false,
          },
          {
            description: 'ESTORNO',
            amountBRL: '50.00',
            purchaseDate: null,
            installmentCurrent: null,
            installmentTotal: null,
            isRefund: true,
          },
        ],
      },
    ]);
    expect(computeParsedTotals(items)).toEqual({
      chargesTotal: '1260.46',
      refundsTotal: '50.00',
      netTotal: '1210.46',
    });
  });

  it('returns a signed delta or null when no printed total exists', () => {
    expect(totalsDelta('1210.46', '1210.46')).toBe('0.00');
    expect(totalsDelta('1210.46', '1215.00')).toBe('-4.54');
    expect(totalsDelta('1210.46', null)).toBeNull();
  });
});
