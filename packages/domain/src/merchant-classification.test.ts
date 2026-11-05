import { describe, expect, it } from 'vitest';
import { normalizeMerchant, suggestMerchantClassification } from './merchant-classification.ts';

describe('reviewed merchant rules', () => {
  const rule = {
    id: 'r1',
    merchant: 'São Café 123',
    cardAccountId: null,
    categoryId: 'food',
    priority: 1,
    version: 1,
  };
  it('normalizes accents and spacing without erasing contract numbers or people', () => {
    expect(normalizeMerchant('  SÃO   Café 123 ')).toBe('sao cafe 123');
    expect(suggestMerchantClassification('sao cafe 124', null, [rule])).toBeNull();
    expect(suggestMerchantClassification('sao cafe 123 Camila', null, [rule])).toBeNull();
    expect(suggestMerchantClassification('sao cafe 123', null, [rule])).toMatchObject({
      ruleId: 'r1',
      requiresReview: true,
      confidence: 'exact',
    });
  });
  it('respects priority, optional card scope and ambiguous ties', () => {
    const scoped = { ...rule, id: 'r2', cardAccountId: 'card1', categoryId: 'work', priority: 2 };
    expect(suggestMerchantClassification(rule.merchant, 'card2', [rule, scoped])?.categoryId).toBe(
      'food',
    );
    expect(suggestMerchantClassification(rule.merchant, 'card1', [rule, scoped])?.categoryId).toBe(
      'work',
    );
    expect(
      suggestMerchantClassification(rule.merchant, 'card1', [
        scoped,
        { ...scoped, id: 'r3', categoryId: 'other' },
      ])?.confidence,
    ).toBe('ambiguous');
  });
  it('keeps marketplaces ambiguous and never infers a category from one word', () => {
    expect(
      suggestMerchantClassification('Amazon', null, [{ ...rule, merchant: 'Amazon' }])?.confidence,
    ).toBe('ambiguous');
    expect(
      suggestMerchantClassification('Amazon Marketplace compra', null, [
        { ...rule, merchant: 'Amazon' },
      ]),
    ).toBeNull();
  });
});
