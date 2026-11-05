/**
 * Deterministic RNG helpers for the demo seed.
 *
 * All "random" demo values (variable-spending amounts, purchase days, merchant
 * picks, income/charge jitter) flow through a seeded mulberry32 generator so
 * re-running the seed produces byte-identical data — reproducibility is a hard
 * requirement of the demo-seed spec.
 */

/** FNV-1a 32-bit hash — turns a stable string seed into a numeric RNG seed. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — tiny, fast, deterministic. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(seed: string) {
    this.next = mulberry32(hashSeed(seed));
  }

  /** Float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Float in [min, max). */
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [minInclusive, maxInclusive]. */
  int(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive < minInclusive) {
      throw new Error(`Rng.int: intervalo inválido [${minInclusive}, ${maxInclusive}]`);
    }
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  /** Uniform pick from a non-empty list. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Rng.pick: lista vazia');
    }
    return items[this.int(0, items.length - 1)];
  }

  /** `n` positive weights that sum to 1 — used to split a monthly total into purchases. */
  weights(n: number): number[] {
    if (n < 1) {
      throw new Error(`Rng.weights: n deve ser >= 1 (recebido ${n})`);
    }
    const raw: number[] = [];
    for (let i = 0; i < n; i++) {
      raw.push(0.4 + this.next());
    }
    const total = raw.reduce((acc, w) => acc + w, 0);
    return raw.map((w) => w / total);
  }
}
