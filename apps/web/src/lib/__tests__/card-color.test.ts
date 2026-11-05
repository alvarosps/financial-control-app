import { describe, expect, it } from 'vitest';
import { cardColor } from '../card-color';

describe('cardColor', () => {
  it('returns a string starting with oklch(', () => {
    expect(cardColor('some-uuid-1234')).toMatch(/^oklch\(/);
  });

  it('same seed always produces the same string', () => {
    const seed = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    expect(cardColor(seed)).toBe(cardColor(seed));
  });

  it('different seeds usually produce different colors', () => {
    const a = cardColor('seed-one');
    const b = cardColor('seed-two');
    // They may theoretically collide mod 360, but won't for these seeds
    expect(a).not.toBe(b);
  });

  it('output matches the expected oklch format', () => {
    const result = cardColor('test-id');
    expect(result).toMatch(/^oklch\(0\.62 0\.17 \d+\)$/);
  });

  it('hue is in the range [0, 359]', () => {
    for (const seed of ['a', 'abc', '00000000-0000-0000-0000-000000000000', 'z'.repeat(50)]) {
      const match = cardColor(seed).match(/oklch\(0\.62 0\.17 (\d+)\)/);
      expect(match).not.toBeNull();
      if (!match) throw new Error('expected an oklch(...) match');
      const hue = parseInt(match[1], 10);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
