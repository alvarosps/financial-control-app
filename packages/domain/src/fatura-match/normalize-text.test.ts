import { describe, expect, it } from 'vitest';
import { normalizeMerchantText, tokenize, tokenSimilarity } from './normalize-text.ts';

describe('normalizeMerchantText', () => {
  it('normalizes casing, accents, standalone digits and punctuation', () => {
    expect(normalizeMerchantText('PADARIA PÃO & CIA 123')).toBe('padaria pao cia');
  });

  it('removes the seven installment grammars found in real statements', () => {
    expect(normalizeMerchantText('MAGAZINELUIZA PARC 03/10')).toBe('magazineluiza');
    expect(normalizeMerchantText('ANUIDADE Int Parc. 5/12')).toBe('anuidade int');
    expect(normalizeMerchantText('Ifd*Sushi Delivery - Parcela 6/6')).toBe('ifd sushi delivery');
    expect(normalizeMerchantText('MERCADOLIVRE*QUALITYFOR Parcela 1 de 8')).toBe(
      'mercadolivre qualityfor',
    );
    expect(normalizeMerchantText('AMAZON BR Sao Paulo(01/13)')).toBe('amazon br sao paulo');
    expect(normalizeMerchantText('LOCACAO DE KITPARC07/12')).toBe('locacao de kit');
    expect(normalizeMerchantText('AMAZON MARKETPLACE09/10')).toBe('amazon marketplace');
  });

  it('collapses whitespace', () => {
    expect(normalizeMerchantText('  UBER   *TRIP  ')).toBe('uber trip');
  });
});

describe('tokenize', () => {
  it('removes one-letter tokens and Portuguese stopwords', () => {
    expect(tokenize('a uber de trip x')).toEqual(['uber', 'trip']);
  });
});

describe('tokenSimilarity', () => {
  it('returns one for equal normalized texts', () => {
    expect(tokenSimilarity('uber trip', 'uber trip')).toBe(1);
  });

  it('returns zero without common tokens', () => {
    expect(tokenSimilarity('uber trip', 'padaria pao')).toBe(0);
  });

  it('scores containment highly', () => {
    expect(tokenSimilarity('amazon', 'amazon marketplace br')).toBeGreaterThanOrEqual(0.85);
  });

  it('matches merchant names even when the extractor removes separators', () => {
    const score = tokenSimilarity(
      normalizeMerchantText('MERCADOLIVREMUNDODOSCOMP'),
      normalizeMerchantText('MERCADOLIVRE*MUNDODOSCOMP'),
    );
    expect(score).toBe(1);
  });

  it('scores a truncated statement name above the weak threshold', () => {
    const score = tokenSimilarity(
      normalizeMerchantText('LOCACAO DE KITPARC07/12'),
      normalizeMerchantText('Locação de Kitnets'),
    );
    expect(score).toBeGreaterThan(0.3);
  });

  it('scores partial overlap between 0.3 and 0.9', () => {
    const score = tokenSimilarity('posto shell centro', 'posto ipiranga centro');
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.9);
  });

  it('returns zero for empty strings', () => {
    expect(tokenSimilarity('', 'uber')).toBe(0);
    expect(tokenSimilarity('', '')).toBe(0);
  });
});
