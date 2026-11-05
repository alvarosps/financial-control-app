import { describe, expect, it } from 'vitest';
import { skeletonKeys } from '../skeleton-keys';

describe('skeletonKeys', () => {
  it('returns exactly count unique stable strings', () => {
    const keys = skeletonKeys(4);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    for (const k of keys) {
      expect(typeof k).toBe('string');
    }
  });
  it('returns the same keys for the same count (stable across renders)', () => {
    expect(skeletonKeys(3)).toEqual(skeletonKeys(3));
  });
  it('throws on non-positive count', () => {
    expect(() => skeletonKeys(0)).toThrow();
    expect(() => skeletonKeys(-1)).toThrow();
  });
});
