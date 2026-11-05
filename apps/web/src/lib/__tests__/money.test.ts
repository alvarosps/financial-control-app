import { describe, expect, it } from 'vitest';
import { moneyStringSchema, toMoneyInputString } from '../money';

describe('toMoneyInputString', () => {
  it('rejects empty, whitespace, and non-numeric inputs as null', () => {
    expect(toMoneyInputString('')).toBeNull();
    expect(toMoneyInputString('   ')).toBeNull();
    expect(toMoneyInputString('abc')).toBeNull();
    expect(toMoneyInputString('NaN')).toBeNull();
  });

  it('rejects zero and negative amounts', () => {
    expect(toMoneyInputString('0')).toBeNull();
    expect(toMoneyInputString('0.00')).toBeNull();
    expect(toMoneyInputString('-5')).toBeNull();
  });

  it('canonicalizes to two fractional digits', () => {
    expect(toMoneyInputString('10')).toBe('10.00');
    expect(toMoneyInputString('12.3')).toBe('12.30');
    expect(toMoneyInputString('12.345')).toBe('12.35');
    expect(toMoneyInputString('  7.5 ')).toBe('7.50');
  });

  it('parses Brazilian decimal/thousands formatting (comma decimal separator)', () => {
    expect(toMoneyInputString('5.180,00')).toBe('5180.00');
    expect(toMoneyInputString('5180,00')).toBe('5180.00');
    expect(toMoneyInputString('1.234.567,89')).toBe('1234567.89');
  });

  it('leaves dot-only decimals untouched', () => {
    expect(toMoneyInputString('5180.00')).toBe('5180.00');
    expect(toMoneyInputString('5.18')).toBe('5.18');
  });

  it('rejects non-positive and empty inputs', () => {
    expect(toMoneyInputString('0')).toBeNull();
    expect(toMoneyInputString('')).toBeNull();
    expect(toMoneyInputString('abc')).toBeNull();
  });

  it('canonical output satisfies moneyStringSchema', () => {
    for (const input of ['1', '10', '100.5', '9999.99']) {
      const out = toMoneyInputString(input);
      expect(out).not.toBeNull();
      expect(() => moneyStringSchema.parse(out)).not.toThrow();
    }
  });
});
