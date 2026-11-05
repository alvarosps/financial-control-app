import { describe, expect, it } from 'vitest';
import { toSignedMoney } from './money-sign';

describe('toSignedMoney', () => {
  it.each([
    ['-9.951,85', '-9951.85'],
    ['9.951,85', '9951.85'],
    ['-9951.85', '-9951.85'],
    ['0', '0.00'],
    [' 25,9 ', '25.90'],
  ])('normalizes %s without changing the amount', (input, expected) => {
    expect(toSignedMoney(input)).toBe(expected);
  });

  it.each([
    '',
    'abc123',
    '1-2',
    'Infinity',
    '1e3',
    '12.34,56',
    '10,123',
  ])('rejects invalid or ambiguous input %s', (input) => expect(toSignedMoney(input)).toBeNull());
});
