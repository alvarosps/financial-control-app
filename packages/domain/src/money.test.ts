import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money } from './money.ts';

describe('Money', () => {
  it('creates from number', () => {
    const m = Money.fromNumber(100.5, 'BRL');
    expect(m.toNumber()).toBe(100.5);
    expect(m.currency).toBe('BRL');
  });

  it('creates from string (database decimal)', () => {
    const m = Money.fromString('100.50', 'BRL');
    expect(m.toNumber()).toBe(100.5);
  });

  it('creates zero', () => {
    const m = Money.zero('BRL');
    expect(m.toNumber()).toBe(0);
    expect(m.isZero()).toBe(true);
  });

  it('adds two money values', () => {
    const a = Money.fromNumber(100.1, 'BRL');
    const b = Money.fromNumber(200.2, 'BRL');
    expect(a.add(b).toNumber()).toBe(300.3);
  });

  it('subtracts two money values', () => {
    const a = Money.fromNumber(300.3, 'BRL');
    const b = Money.fromNumber(100.1, 'BRL');
    expect(a.subtract(b).toNumber()).toBe(200.2);
  });

  it('prevents adding different currencies', () => {
    const brl = Money.fromNumber(100, 'BRL');
    const usd = Money.fromNumber(50, 'USD');
    expect(() => brl.add(usd)).toThrow('Cannot operate on different currencies');
  });

  it('negates', () => {
    const m = Money.fromNumber(100, 'BRL');
    expect(m.negate().toNumber()).toBe(-100);
  });

  it('compares', () => {
    const a = Money.fromNumber(100, 'BRL');
    const b = Money.fromNumber(200, 'BRL');
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isGreaterThan(a)).toBe(true);
    expect(a.equals(Money.fromNumber(100, 'BRL'))).toBe(true);
  });

  it('handles negative values', () => {
    const m = Money.fromNumber(-50.25, 'BRL');
    expect(m.toNumber()).toBe(-50.25);
    expect(m.isNegative()).toBe(true);
  });

  it('rounds to 2 decimal places', () => {
    const a = Money.fromNumber(10.0, 'BRL');
    expect(a.divide(3).toNumber()).toBe(3.33);
  });

  it('property: a + b == b + a', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (a, b) => {
          const ma = Money.fromNumber(a / 100, 'BRL');
          const mb = Money.fromNumber(b / 100, 'BRL');
          expect(ma.add(mb).toNumber()).toBe(mb.add(ma).toNumber());
        },
      ),
    );
  });

  it('sum of many cents is exact (no float drift)', () => {
    const items = Array.from({ length: 1000 }, () => Money.fromString('0.01', 'BRL'));
    expect(Money.sum(items, 'BRL').toString()).toBe('10.00');
  });

  it('sum of empty list returns zero with given currency', () => {
    expect(Money.sum([], 'USD').toNumber()).toBe(0);
    expect(Money.sum([], 'USD').currency).toBe('USD');
  });

  it('sum throws on currency mismatch', () => {
    const items = [Money.fromNumber(1, 'BRL'), Money.fromNumber(1, 'USD')];
    expect(() => Money.sum(items)).toThrow(/currency mismatch/i);
  });

  it('Money.sum throws on heterogeneous currencies', () => {
    expect(() =>
      Money.sum([Money.fromString('10.00', 'BRL'), Money.fromString('5.00', 'USD')], 'BRL'),
    ).toThrow(/currency mismatch/i);
  });

  it('sum throws when every item has a single currency that differs from target', () => {
    const items = [Money.fromNumber(1, 'USD'), Money.fromNumber(2, 'USD')];
    expect(() => Money.sum(items, 'BRL')).toThrow(/currency mismatch/i);
  });

  it('property: (a + b) - b == a', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (a, b) => {
          const ma = Money.fromNumber(a / 100, 'BRL');
          const mb = Money.fromNumber(b / 100, 'BRL');
          expect(ma.add(mb).subtract(mb).toNumber()).toBe(ma.toNumber());
        },
      ),
    );
  });
});
