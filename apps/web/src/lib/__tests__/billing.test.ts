import { describe, expect, it } from 'vitest';
import { currentFatura, faturaWindow } from '../billing';

describe('currentFatura', () => {
  it('after closing day rolls to next month', () => {
    expect(currentFatura(new Date(2026, 5, 7), 6)).toEqual({ month: 7, year: 2026 });
  });
  it('on/before closing day stays in month', () => {
    expect(currentFatura(new Date(2026, 5, 5), 6)).toEqual({ month: 6, year: 2026 });
  });
  it('December after closing rolls to January next year', () => {
    expect(currentFatura(new Date(2026, 11, 20), 6)).toEqual({ month: 1, year: 2027 });
  });
});

describe('faturaWindow', () => {
  it('6 back..6 forward crosses year boundary by ordinal', () => {
    const w = faturaWindow({ month: 1, year: 2027 }, 6, 6);
    expect(w[0]).toEqual({ month: 7, year: 2026 });
    expect(w[w.length - 1]).toEqual({ month: 7, year: 2027 });
    expect(w).toHaveLength(13);
  });
});
