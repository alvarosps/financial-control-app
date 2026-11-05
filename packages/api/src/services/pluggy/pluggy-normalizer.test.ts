import { describe, expect, it } from 'vitest';
import { normalizePluggyCard } from './pluggy-normalizer.ts';
import { pluggyTransactionSchema } from './pluggy-types.ts';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  description: 'Fixture',
  amount: -100,
  currencyCode: 'BRL',
  date: '2026-09-28T00:00:00Z',
  type: 'DEBIT',
  status: 'POSTED',
  createdAt: '2026-09-28T00:00:00Z',
  updatedAt: '2026-09-28T00:00:00Z',
};
const card = '33333333-3333-4333-8333-333333333333';
const normalize = (changes: Record<string, unknown> = {}, retracted = false) =>
  normalizePluggyCard(pluggyTransactionSchema.parse({ ...base, ...changes }), card, retracted);

describe('Pluggy card normalization', () => {
  it('keeps incomplete installment metadata unresolved instead of treating it as a single purchase', () => {
    expect(normalize({ creditCardMetadata: { installmentNumber: 5 } })).toMatchObject({
      data: { amountMeaning: 'unknown', installmentNumber: null, totalInstallments: null },
    });
    expect(
      normalize({ creditCardMetadata: { installmentNumber: 5, totalInstallments: 1 } }),
    ).toMatchObject({
      data: { amountMeaning: 'unknown', installmentNumber: null, totalInstallments: null },
    });
  });
  it('normalizes one purchase without inferring a purchase date or accounting cycle', () => {
    expect(normalize()).toEqual({
      kind: 'purchase',
      data: {
        cardAccountId: card,
        description: 'Fixture',
        amount: '100.00',
        currency: 'BRL',
        amountMeaning: 'purchase_total',
        kind: 'purchase',
        purchaseDate: null,
        postedDate: '2026-09-28',
        installmentNumber: null,
        totalInstallments: null,
        confirmation: 'posted',
      },
    });
  });
  it.each([
    1, 5,
  ])('keeps installment %s/N meaning unconfirmed until the bank contract is reviewed', (installmentNumber) => {
    expect(
      normalize({
        creditCardMetadata: {
          installmentNumber,
          totalInstallments: 12,
          totalAmount: 1200,
          purchaseDate: '2026-05-01',
        },
      }),
    ).toMatchObject({
      kind: 'purchase',
      data: {
        amount: '100.00',
        amountMeaning: 'unknown',
        installmentNumber,
        totalInstallments: 12,
        purchaseDate: '2026-05-01',
      },
    });
  });
  it('uses type and operation metadata rather than a negative amount to invent refunds', () => {
    expect(normalize()).toMatchObject({ data: { kind: 'purchase' } });
    expect(normalize({ type: 'CREDIT', amount: 100 })).toEqual({
      kind: 'review',
      reason: 'unknown_credit',
    });
    for (const amount of [25, 100])
      expect(normalize({ type: 'CREDIT', amount, operationType: 'ESTORNO' })).toMatchObject({
        data: { kind: 'refund', amount: `${amount}.00`, totalInstallments: null },
      });
    expect(normalize({ type: 'CREDIT', operationType: 'PAGAMENTO_FATURA' })).toEqual({
      kind: 'payment',
    });
  });
  it('preserves currency, pending/posting/retraction and masked additional-card evidence', () => {
    expect(
      normalize({ currencyCode: 'USD', amountInAccountCurrency: -500, status: 'PENDING' }),
    ).toMatchObject({
      data: { amount: '100.00', currency: 'USD', confirmation: 'pending', postedDate: null },
    });
    expect(normalize({}, true)).toMatchObject({ data: { confirmation: 'retracted' } });
    expect(
      pluggyTransactionSchema.parse({
        ...base,
        creditCardMetadata: { cardNumber: '1234 5678 9012 3456' },
      }).creditCardMetadata?.cardNumber,
    ).toBe('3456');
  });
});
