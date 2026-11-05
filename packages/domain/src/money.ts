import Decimal from 'decimal.js';
import { assertIso4217 } from './currency.ts';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static fromNumber(amount: number, currency: string): Money {
    assertIso4217(currency);
    return new Money(new Decimal(amount).toDecimalPlaces(2), currency);
  }

  static fromString(amount: string, currency: string): Money {
    assertIso4217(currency);
    return new Money(new Decimal(amount).toDecimalPlaces(2), currency);
  }

  /**
   * Construct a Money from a raw Decimal WITHOUT rounding to 2 decimals.
   *
   * Intended for values that are not yet at the currency boundary — e.g.
   * interest rates (0.0085) or in-flight multi-step computations where
   * intermediate precision must be preserved. Callers are responsible for
   * rounding at the final boundary.
   *
   * Currency arithmetic methods (`add`, `subtract`, …) still round to 2dp;
   * do not mix rate-bearing Money with currency-bearing Money through them.
   */
  static fromDecimal(d: Decimal, currency: string): Money {
    assertIso4217(currency);
    return new Money(d, currency);
  }

  static zero(currency: string): Money {
    assertIso4217(currency);
    return new Money(new Decimal(0), currency);
  }

  /** Returns the underlying Decimal (raw, unrounded). */
  toDecimal(): Decimal {
    return this.value;
  }

  /**
   * Canonical DB/wire serialization: 2 decimals, ROUND_HALF_UP, no currency
   * prefix. Matches the repo's `/^\d+\.\d{2}$/` money-string convention.
   * NOTE: `.toFixed(2)` here is Decimal.prototype.toFixed — lossless rounding
   * at arbitrary precision, NOT the lossy Number.prototype.toFixed the
   * audit forbids across services.
   */
  toDbString(): string {
    return this.value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Cannot operate on different currencies: ${this.currency} vs ${other.currency}`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value).toDecimalPlaces(2), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value).toDecimalPlaces(2), this.currency);
  }

  multiply(factor: number): Money {
    return new Money(this.value.times(factor).toDecimalPlaces(2), this.currency);
  }

  divide(divisor: number): Money {
    return new Money(this.value.dividedBy(divisor).toDecimalPlaces(2), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated().toDecimalPlaces(2), this.currency);
  }

  abs(): Money {
    return new Money(this.value.abs().toDecimalPlaces(2), this.currency);
  }

  toNumber(): number {
    return this.value.toNumber();
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  format(locale: string = 'pt-BR'): string {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: this.currency,
    }).format(this.value.toNumber());
  }

  /**
   * Sum a list of Money values into `currency`. Throws if any input has a
   * different currency — no silent coercion. Empty list returns zero in
   * `currency`. This is strictly stronger than relying on `.add()`'s
   * same-currency check, because that would only catch the first mismatched
   * pair and would silently accept a list where every item shares a single
   * currency that differs from the target.
   */
  static sum(values: Money[], currency: string = 'BRL'): Money {
    let acc = Money.zero(currency);
    for (const v of values) {
      if (v.currency !== currency) {
        throw new Error(`Money.sum currency mismatch: expected ${currency}, got ${v.currency}`);
      }
      acc = acc.add(v);
    }
    return acc;
  }
}
