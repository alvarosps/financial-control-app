import { describe, expect, it } from 'vitest';
import { moneySchema, notesSchema, positiveRateSchema } from './schemas.ts';

describe('positiveRateSchema', () => {
  it('accepts a valid positive rate', () => {
    expect(positiveRateSchema.safeParse('5.40').success).toBe(true);
    expect(positiveRateSchema.safeParse('1.00').success).toBe(true);
    expect(positiveRateSchema.safeParse('0.01').success).toBe(true);
  });

  it('rejects zero', () => {
    expect(positiveRateSchema.safeParse('0').success).toBe(false);
    expect(positiveRateSchema.safeParse('0.00').success).toBe(false);
  });

  it('rejects negative values', () => {
    expect(positiveRateSchema.safeParse('-5').success).toBe(false);
    expect(positiveRateSchema.safeParse('-5.40').success).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    expect(positiveRateSchema.safeParse('abc').success).toBe(false);
    expect(positiveRateSchema.safeParse('').success).toBe(false);
  });
});

describe('moneySchema', () => {
  it('accepts valid amounts up to the cap', () => {
    expect(moneySchema.safeParse('0.01').success).toBe(true);
    expect(moneySchema.safeParse('123.45').success).toBe(true);
    expect(moneySchema.safeParse('99999999.99').success).toBe(true);
  });

  it('rejects amounts above 99,999,999.99', () => {
    expect(moneySchema.safeParse('100000000.00').success).toBe(false);
    expect(moneySchema.safeParse('999999999999.00').success).toBe(false);
  });

  it('rejects zero, negatives and malformed strings', () => {
    expect(moneySchema.safeParse('0.00').success).toBe(false);
    expect(moneySchema.safeParse('-10.00').success).toBe(false);
    expect(moneySchema.safeParse('10').success).toBe(false);
    expect(moneySchema.safeParse('10.5').success).toBe(false);
  });
});

describe('notesSchema', () => {
  it('accepts up to 1000 chars and rejects beyond', () => {
    expect(notesSchema.safeParse('x'.repeat(1000)).success).toBe(true);
    expect(notesSchema.safeParse('x'.repeat(1001)).success).toBe(false);
  });
});
