import { describe, expect, it } from 'vitest';
import { hashSeed, mulberry32, Rng } from './rng.ts';

describe('hashSeed', () => {
  it('is deterministic and distinguishes different inputs', () => {
    expect(hashSeed('fc-demo-v1:rafael')).toBe(hashSeed('fc-demo-v1:rafael'));
    expect(hashSeed('fc-demo-v1:rafael')).not.toBe(hashSeed('fc-demo-v1:marina'));
  });
});

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(123456);
    const b = mulberry32(123456);
    for (let i = 0; i < 20; i++) {
      expect(a()).toBe(b());
    }
  });

  it('produces floats in [0, 1)', () => {
    const next = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('Rng', () => {
  it('same string seed reproduces the same draws', () => {
    const a = new Rng('seed-x');
    const b = new Rng('seed-x');
    expect(a.uniform(10, 20)).toBe(b.uniform(10, 20));
    expect(a.int(1, 6)).toBe(b.int(1, 6));
    expect(a.pick(['x', 'y', 'z'])).toBe(b.pick(['x', 'y', 'z']));
  });

  it('uniform stays within [min, max)', () => {
    const rng = new Rng('bounds');
    for (let i = 0; i < 500; i++) {
      const v = rng.uniform(100, 250);
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThan(250);
    }
  });

  it('int covers both inclusive bounds', () => {
    const rng = new Rng('int-bounds');
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = rng.int(1, 3);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(3);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([1, 2, 3]));
  });

  it('int rejects an inverted range', () => {
    const rng = new Rng('bad-range');
    expect(() => rng.int(5, 4)).toThrow(/intervalo inválido/);
  });

  it('pick rejects an empty list', () => {
    const rng = new Rng('empty');
    expect(() => rng.pick([])).toThrow(/lista vazia/);
  });

  it('weights returns n positive weights summing to ~1', () => {
    const rng = new Rng('weights');
    const w = rng.weights(4);
    expect(w).toHaveLength(4);
    for (const value of w) {
      expect(value).toBeGreaterThan(0);
    }
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('weights rejects n < 1', () => {
    const rng = new Rng('weights-bad');
    expect(() => rng.weights(0)).toThrow(/n deve ser >= 1/);
  });
});
