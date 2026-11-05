const POOL = [
  'sk-alpha',
  'sk-beta',
  'sk-gamma',
  'sk-delta',
  'sk-epsilon',
  'sk-zeta',
  'sk-eta',
  'sk-theta',
  'sk-iota',
  'sk-kappa',
  'sk-lambda',
  'sk-mu',
] as const;

export function skeletonKeys(count: number): readonly string[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`skeletonKeys: count must be a positive integer, got ${count}`);
  }
  if (count > POOL.length) {
    throw new Error(`skeletonKeys: count ${count} exceeds pool size ${POOL.length}`);
  }
  return POOL.slice(0, count);
}
