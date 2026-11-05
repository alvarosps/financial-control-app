import { describe, expect, it } from 'vitest';
import { fuzzyFilter } from '../fuzzy-search';

type Item = { description: string };

const items: Item[] = [
  { description: 'Netflix' },
  { description: 'Spotify Premium' },
  { description: 'Amazon Prime' },
  { description: 'Disney Plus' },
];

describe('fuzzyFilter', () => {
  it('returns all items for empty query', () => {
    expect(fuzzyFilter(items, '', ['description'])).toEqual(items);
    expect(fuzzyFilter(items, '   ', ['description'])).toEqual(items);
  });

  it('matches exact substrings', () => {
    const r = fuzzyFilter(items, 'Netflix', ['description']);
    expect(r).toHaveLength(1);
    expect(r[0]?.description).toBe('Netflix');
  });

  it('tolerates typos', () => {
    const r = fuzzyFilter(items, 'netflx', ['description']);
    expect(r.map((i) => i.description)).toContain('Netflix');
  });

  it('is case insensitive', () => {
    const r = fuzzyFilter(items, 'spotify', ['description']);
    expect(r.map((i) => i.description)).toContain('Spotify Premium');
  });

  it('returns empty array when no plausible match', () => {
    const r = fuzzyFilter(items, 'zzzzzzzzzz', ['description']);
    expect(r).toEqual([]);
  });
});
