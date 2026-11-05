import { describe, expect, it } from 'vitest';
import { formatCompactBRL } from '@/lib/format';

describe('formatCompactBRL', () => {
  it('formats thousands with a k suffix and one decimal (pt-BR comma)', () => {
    expect(formatCompactBRL(1234.56)).toBe('R$ 1,2k');
    expect(formatCompactBRL(15000)).toBe('R$ 15k');
  });

  it('formats millions with an M suffix', () => {
    expect(formatCompactBRL(2500000)).toBe('R$ 2,5M');
  });

  it('keeps sub-thousand values whole', () => {
    expect(formatCompactBRL(950)).toBe('R$ 950');
    expect(formatCompactBRL(0)).toBe('R$ 0');
  });

  it('prefixes the sign for negatives', () => {
    expect(formatCompactBRL(-250000)).toBe('-R$ 250k');
    expect(formatCompactBRL(-999.4)).toBe('-R$ 999');
  });
});
