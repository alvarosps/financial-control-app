import { describe, expect, it } from 'vitest';
import { analyzeInstallmentReversals } from './reversal.ts';
import type { ExpectedItem, ParsedItem } from './types.ts';

function installment(
  current: number,
  amountBRL: string,
  overrides: Partial<ParsedItem> = {},
): ParsedItem {
  return {
    description: 'MERCADOLIVREMERCADOLIVRE',
    amountBRL,
    purchaseDate: '2026-06-07',
    installmentCurrent: current,
    installmentTotal: 12,
    isRefund: false,
    cardLastFour: '0089',
    holderName: 'ALVARO',
    isAdditional: false,
    ...overrides,
  };
}

function refund(amountBRL: string): ParsedItem {
  return {
    description: 'CREDITO CONCEDIDO',
    amountBRL,
    purchaseDate: '2026-06-27',
    installmentCurrent: null,
    installmentTotal: null,
    isRefund: true,
    cardLastFour: '0089',
    holderName: 'ALVARO',
    isAdditional: false,
  };
}

function expected(overrides: Partial<ExpectedItem> = {}): ExpectedItem {
  return {
    transactionId: 'tx-2',
    cardAccountId: 'card-1',
    scheduleId: 'schedule-1',
    description: 'MERCADOLIVRE*MERCADOLI (207,46)',
    amountBRL: '207.46',
    date: '2026-07-06',
    domainType: 'credit_card_installment',
    installmentNumber: 2,
    totalInstallments: 12,
    ...overrides,
  };
}

describe('analyzeInstallmentReversals', () => {
  it('neutralizes a full installment sequence offset by an exact credit', () => {
    const charges = [
      installment(1, '86.62'),
      ...Array.from({ length: 11 }, (_, index) => installment(index + 2, '86.58')),
    ];

    const result = analyzeInstallmentReversals({
      parsed: [...charges, refund('1039.00')],
      expected: [],
      paidTotalsBySchedule: {},
    });

    expect(result.reversalBundles).toHaveLength(1);
    expect(result.reversalBundles[0]).toMatchObject({
      expected: null,
      chargesTotalBRL: '1039.00',
      creditTotalBRL: '1039.00',
      netRefundBRL: '0.00',
    });
    expect(result.parsed).toHaveLength(0);
    expect(result.expected).toHaveLength(0);
    expect(result.blockedGroups).toHaveLength(0);
  });

  it('cancels an existing schedule and keeps only the refund of paid installments', () => {
    const charges = Array.from({ length: 11 }, (_, index) =>
      installment(index + 2, '207.37', {
        description: 'MERCADOLIVREMERCADOLI',
        purchaseDate: '2026-05-24',
      }),
    );
    const existing = expected();

    const result = analyzeInstallmentReversals({
      parsed: [...charges, refund('2488.53')],
      expected: [existing],
      paidTotalsBySchedule: { 'schedule-1': '207.46' },
    });

    expect(result.reversalBundles).toHaveLength(1);
    expect(result.reversalBundles[0]).toMatchObject({
      expected: existing,
      chargesTotalBRL: '2281.07',
      creditTotalBRL: '2488.53',
      netRefundBRL: '207.46',
    });
    expect(result.parsed).toHaveLength(0);
    expect(result.expected).toHaveLength(0);
    expect(result.blockedGroups).toHaveLength(0);
  });

  it('neutralizes installments canceled by one refund line per installment', () => {
    const charges = [
      installment(1, '17.50', {
        description: 'MERCADOLIVRE*M',
        purchaseDate: '2026-06-14',
        installmentTotal: 2,
      }),
      installment(2, '17.50', {
        description: 'MERCADOLIVRE*M',
        purchaseDate: '2026-06-14',
        installmentTotal: 2,
      }),
    ];
    const refunds = charges.map((charge) => ({
      ...charge,
      description: 'CANC PARCELA S',
      isRefund: true,
    }));

    const result = analyzeInstallmentReversals({
      parsed: [...charges, ...refunds],
      expected: [],
      paidTotalsBySchedule: {},
    });

    expect(result.reversalBundles).toHaveLength(1);
    expect(result.reversalBundles[0]).toMatchObject({
      charges,
      refunds,
      expected: null,
      chargesTotalBRL: '35.00',
      creditTotalBRL: '35.00',
      netRefundBRL: '0.00',
    });
    expect(result.parsed).toHaveLength(0);
    expect(result.blockedGroups).toHaveLength(0);
  });

  it('does not collapse a cancellation when one installment has ambiguous refund lines', () => {
    const charges = [
      installment(1, '17.50', {
        description: 'MERCADOLIVRE*M',
        purchaseDate: '2026-06-14',
        installmentTotal: 2,
      }),
      installment(2, '17.50', {
        description: 'MERCADOLIVRE*M',
        purchaseDate: '2026-06-14',
        installmentTotal: 2,
      }),
    ];
    const firstCharge = charges[0];
    const secondCharge = charges[1];
    expect(firstCharge).toBeDefined();
    expect(secondCharge).toBeDefined();
    if (firstCharge === undefined || secondCharge === undefined) return;
    const refunds = [
      { ...firstCharge, description: 'CANC PARCELA S', isRefund: true },
      { ...firstCharge, description: 'OUTRO ESTORNO', isRefund: true },
      { ...secondCharge, description: 'CANC PARCELA S', isRefund: true },
    ];

    const result = analyzeInstallmentReversals({
      parsed: [...charges, ...refunds],
      expected: [],
      paidTotalsBySchedule: {},
    });

    expect(result.reversalBundles).toHaveLength(0);
    expect(result.blockedGroups).toEqual([
      expect.objectContaining({
        items: charges,
        reason: 'multiple_installments_same_purchase',
      }),
    ]);
    expect(result.parsed).toEqual(refunds);
  });

  it('blocks repeated installments when no exact offsetting credit exists', () => {
    const charges = [installment(2, '100.00'), installment(3, '100.00'), installment(4, '100.00')];
    const ordinary = installment(1, '25.00', {
      description: 'OUTRA COMPRA',
      installmentTotal: 2,
    });

    const result = analyzeInstallmentReversals({
      parsed: [...charges, ordinary],
      expected: [],
      paidTotalsBySchedule: {},
    });

    expect(result.reversalBundles).toHaveLength(0);
    expect(result.blockedGroups).toHaveLength(1);
    expect(result.blockedGroups[0]?.items).toEqual(charges);
    expect(result.parsed).toEqual([ordinary]);
  });

  it('does not collapse duplicated purchases with repeated installment numbers', () => {
    const repeatedCurrent = [
      installment(1, '50.00'),
      installment(1, '50.00'),
      installment(2, '50.00'),
      installment(2, '50.00'),
    ];

    const result = analyzeInstallmentReversals({
      parsed: repeatedCurrent,
      expected: [],
      paidTotalsBySchedule: {},
    });

    expect(result.reversalBundles).toHaveLength(0);
    expect(result.blockedGroups).toHaveLength(0);
    expect(result.parsed).toEqual(repeatedCurrent);
  });
});
