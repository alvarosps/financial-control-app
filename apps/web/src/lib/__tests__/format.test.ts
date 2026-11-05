import { describe, expect, it } from 'vitest';
import { formatCurrency, formatCurrencyValue, formatPercent } from '../format';

// These tests lock in the hydration-determinism fix: Intl can emit a no-break
// (U+00A0) or narrow-no-break (U+202F) space around the currency symbol / percent
// sign, and Node's ICU vs the browser's ICU may disagree on which — causing a
// server/client hydration mismatch on every money value. The formatters must
// normalize those to a plain space so SSR and client output are byte-identical.
const NBSP = /[  ]/;

describe('formatCurrencyValue (hydration determinism)', () => {
  it('never emits a non-breaking / narrow-no-break space', () => {
    for (const v of [0, 1, 12.3, 1234.56, -9876.54, 1_000_000]) {
      expect(formatCurrencyValue(v)).not.toMatch(NBSP);
    }
  });

  it('formats BRL with pt-BR grouping and a plain space', () => {
    const out = formatCurrencyValue(1234.56);
    expect(out).toContain('R$');
    expect(out).toContain('1.234,56');
    expect(out).not.toMatch(NBSP);
  });

  it('formatCurrency delegates to the normalized formatter', () => {
    expect(formatCurrency(1234.56)).toBe(formatCurrencyValue(1234.56));
  });

  it('supports other currencies without breaking normalization', () => {
    expect(formatCurrencyValue(50, 'USD')).not.toMatch(NBSP);
  });
});

describe('formatPercent (hydration determinism)', () => {
  it('never emits a non-breaking / narrow-no-break space', () => {
    for (const v of [0, 12.5, 100, 33.33]) {
      expect(formatPercent(v)).not.toMatch(NBSP);
    }
  });
});
