import { describe, expect, it } from 'vitest';
import { canManuallyLinkFaturaItem } from './manual-link.ts';
import type { ExpectedItem, ParsedItem } from './types.ts';

function parsed(overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    description: 'ESTORNO DE ANUIDADE DIF',
    amountBRL: '52.50',
    purchaseDate: '2026-07-01',
    installmentCurrent: null,
    installmentTotal: null,
    isRefund: true,
    cardLastFour: null,
    holderName: null,
    isAdditional: false,
    ...overrides,
  };
}

function expected(overrides: Partial<ExpectedItem> = {}): ExpectedItem {
  return {
    transactionId: 'tx-1',
    cardAccountId: 'card-1',
    scheduleId: 'schedule-1',
    description: 'Estorno Anuidade Diferenciada',
    amountBRL: '105.00',
    date: '2026-07-01',
    domainType: 'credit_card_refund',
    installmentNumber: null,
    totalInstallments: null,
    ...overrides,
  };
}

describe('canManuallyLinkFaturaItem', () => {
  it('allows a statement refund to link to an existing refund', () => {
    expect(
      canManuallyLinkFaturaItem({
        parsed: parsed(),
        expected: expected(),
        targetCardAccountId: 'card-1',
      }),
    ).toBe(true);
  });

  it('does not link a refund to a charge', () => {
    expect(
      canManuallyLinkFaturaItem({
        parsed: parsed(),
        expected: expected({ domainType: 'credit_card_expense', scheduleId: null }),
        targetCardAccountId: 'card-1',
      }),
    ).toBe(false);
  });

  it('does not link a charge to a refund', () => {
    expect(
      canManuallyLinkFaturaItem({
        parsed: parsed({ isRefund: false }),
        expected: expected(),
        targetCardAccountId: 'card-1',
      }),
    ).toBe(false);
  });

  it('requires the exact amount for a paid refund', () => {
    expect(
      canManuallyLinkFaturaItem({
        parsed: parsed(),
        expected: expected({ isPaid: true }),
        targetCardAccountId: 'card-1',
      }),
    ).toBe(false);
    expect(
      canManuallyLinkFaturaItem({
        parsed: parsed({ amountBRL: '105.00' }),
        expected: expected({ isPaid: true }),
        targetCardAccountId: 'card-1',
      }),
    ).toBe(true);
  });
});
