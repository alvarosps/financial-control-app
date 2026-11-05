import { describe, expect, it } from 'vitest';
import { assertIso4217, isIso4217, SUPPORTED_CURRENCIES } from '../currency';

describe('currency', () => {
  it('accepts currencies this app uses', () => {
    expect(isIso4217('BRL')).toBe(true);
    expect(isIso4217('USD')).toBe(true);
    expect(isIso4217('EUR')).toBe(true);
    expect(isIso4217('GBP')).toBe(true);
  });

  it('rejects empty, lowercase, or unknown codes', () => {
    expect(isIso4217('')).toBe(false);
    expect(isIso4217('brl')).toBe(false);
    expect(isIso4217('XXX')).toBe(false);
    expect(isIso4217('BTC')).toBe(false);
    expect(isIso4217('BR')).toBe(false);
    expect(isIso4217('BRLL')).toBe(false);
  });

  it('assert throws with the offending code in the message', () => {
    expect(() => assertIso4217('btc')).toThrow(/btc/);
    expect(() => assertIso4217('')).toThrow();
  });

  it('exposes the supported set', () => {
    expect(SUPPORTED_CURRENCIES.has('BRL')).toBe(true);
    expect(SUPPORTED_CURRENCIES.size).toBeGreaterThanOrEqual(4);
  });
});
