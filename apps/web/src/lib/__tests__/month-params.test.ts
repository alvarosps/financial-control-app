import { describe, expect, it } from 'vitest';
import {
  currentMonthYear,
  parseMonthParam,
  parseYearParam,
  resolveMonthYear,
} from '../month-params';

describe('parseMonthParam', () => {
  it('accepts month values from 1 through 12', () => {
    expect(parseMonthParam('1')).toBe(1);
    expect(parseMonthParam('07')).toBe(7);
    expect(parseMonthParam('12')).toBe(12);
  });

  it('rejects invalid values', () => {
    expect(parseMonthParam('0')).toBeNull();
    expect(parseMonthParam('13')).toBeNull();
    expect(parseMonthParam('7.5')).toBeNull();
    expect(parseMonthParam('abc')).toBeNull();
    expect(parseMonthParam('')).toBeNull();
    expect(parseMonthParam(null)).toBeNull();
    expect(parseMonthParam(undefined)).toBeNull();
  });

  it('uses the first server search-param value', () => {
    expect(parseMonthParam(['3', '9'])).toBe(3);
    expect(parseMonthParam([])).toBeNull();
  });
});

describe('parseYearParam', () => {
  it('accepts the API month-navigation bounds', () => {
    expect(parseYearParam('2000')).toBe(2000);
    expect(parseYearParam('2026')).toBe(2026);
    expect(parseYearParam('2100')).toBe(2100);
  });

  it('rejects out-of-range and non-integer values', () => {
    expect(parseYearParam('1999')).toBeNull();
    expect(parseYearParam('2101')).toBeNull();
    expect(parseYearParam('20x6')).toBeNull();
    expect(parseYearParam(null)).toBeNull();
  });
});

describe('resolveMonthYear', () => {
  it('uses valid URL params and falls back independently for invalid ones', () => {
    expect(resolveMonthYear({ month: '3', year: '2025' }, { month: 6, year: 2026 })).toEqual({
      month: 3,
      year: 2025,
    });
    expect(resolveMonthYear({ month: '99', year: '2025' }, { month: 6, year: 2026 })).toEqual({
      month: 6,
      year: 2025,
    });
  });

  it('uses the current Sao Paulo month when no fallback is supplied', () => {
    expect(resolveMonthYear({})).toEqual(currentMonthYear());
  });
});
