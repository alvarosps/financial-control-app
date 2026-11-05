import { Money } from '@fc/domain';
import { describe, expect, it } from 'vitest';
import { convertIncomeToBrl } from './fx';

describe('convertIncomeToBrl', () => {
  it('applies the fee to forex income (USD * rate * 0.99)', () => {
    const r = convertIncomeToBrl(Money.fromString('2769.60', 'USD'), 'USD', null, '5.1671', '1');
    const expected = Money.fromString('2769.60', 'USD')
      .multiply(5.1671)
      .multiply(1 - 1 / 100);
    expect(r.toDbString()).toBe(expected.toDbString());
  });

  it('no fee for BRL amounts (already net)', () => {
    const r = convertIncomeToBrl(Money.fromString('100.00', 'BRL'), 'BRL', null, null, '1');
    expect(r.toDbString()).toBe('100.00');
  });

  it('zero/absent fee = plain conversion', () => {
    const r = convertIncomeToBrl(Money.fromString('100.00', 'USD'), 'USD', null, '5.00', null);
    expect(r.toDbString()).toBe('500.00');
  });

  it('throws on missing rate for forex (delegates to convertToBrl validation)', () => {
    expect(() =>
      convertIncomeToBrl(Money.fromString('100.00', 'USD'), 'USD', null, null, '1'),
    ).toThrow();
  });

  it('clamps a >100% fee to 0 (never produces negative income)', () => {
    const r = convertIncomeToBrl(Money.fromString('100.00', 'USD'), 'USD', null, '5.00', '150');
    expect(r.toDbString()).toBe('0.00');
  });

  it('clamps a 100% fee to 0', () => {
    const r = convertIncomeToBrl(Money.fromString('100.00', 'USD'), 'USD', null, '5.00', '100');
    expect(r.toDbString()).toBe('0.00');
  });
});
