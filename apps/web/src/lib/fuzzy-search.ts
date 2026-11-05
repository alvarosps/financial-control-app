import Fuse, { type IFuseOptions } from 'fuse.js';

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  keys: readonly (keyof T & string)[],
  opts: IFuseOptions<T> = {},
): T[] {
  const q = query.trim();
  if (!q) return [...items];
  const fuse = new Fuse(items as T[], {
    keys: [...keys],
    threshold: 0.35,
    ignoreLocation: true,
    isCaseSensitive: false,
    ...opts,
  });
  return fuse.search(q).map((r) => r.item);
}
