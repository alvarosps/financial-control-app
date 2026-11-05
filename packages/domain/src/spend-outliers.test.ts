// packages/domain/src/spend-outliers.test.ts
import { describe, expect, it } from 'vitest';
import { detectOutlierMonths, type OutlierInput, outlierReasons } from './spend-outliers.ts';

const m = (total: number, iof = 0): OutlierInput => ({ total, iof });

describe('detectOutlierMonths', () => {
  it('flags only the statistical spike among otherwise typical months', () => {
    const months = [m(1000), m(1100), m(1050), m(5000), m(1000), m(950)];
    expect(detectOutlierMonths(months)).toEqual([false, false, false, true, false, false]);
  });

  it('flags nothing below the min-data threshold (statistical test cannot fire)', () => {
    const months = [m(1000), m(5000)];
    expect(detectOutlierMonths(months)).toEqual([false, false]);
  });

  it('flags a month via the IOF rule even when the statistical test cannot fire', () => {
    const months = [m(1000, 0), m(1200, 80)];
    expect(detectOutlierMonths(months)).toEqual([false, true]);
  });

  it('flags nothing statistically when MAD is zero (all-equal totals)', () => {
    const months = [m(1000), m(1000), m(1000), m(1000)];
    expect(detectOutlierMonths(months)).toEqual([false, false, false, false]);
  });
});

describe('outlierReasons', () => {
  it("tags the statistical spike with ['statistical'] and nothing elsewhere", () => {
    const months = [m(1000), m(1100), m(1050), m(5000), m(1000), m(950)];
    const reasons = outlierReasons(months);
    expect(reasons[3]).toEqual(['statistical']);
    expect(reasons[0]).toEqual([]);
    expect(reasons[1]).toEqual([]);
    expect(reasons[2]).toEqual([]);
    expect(reasons[4]).toEqual([]);
    expect(reasons[5]).toEqual([]);
  });

  it('tags an IOF-only month with the IOF reason', () => {
    const reasons = outlierReasons([m(1000, 0), m(1200, 80)]);
    expect(reasons[0]).toEqual([]);
    expect(reasons[1]).toEqual(['iof']);
  });

  it("lists 'statistical' before 'iof' when a month trips both rules", () => {
    const months = [m(1000), m(1100), m(1050), m(5000, 90), m(1000), m(950)];
    const reasons = outlierReasons(months);
    expect(reasons[3]).toEqual(['statistical', 'iof']);
    expect(reasons[0]).toEqual([]);
  });
});

describe('detectOutlierMonths / outlierReasons agreement', () => {
  it('flags a month true iff its reasons array is non-empty (mixed fixture)', () => {
    const months = [
      m(1000), // typical
      m(1100), // typical
      m(1050), // typical
      m(5000), // statistical spike
      m(1200, 80), // IOF-only
      m(5000, 90), // statistical + IOF
      m(950), // typical
    ];
    const flags = detectOutlierMonths(months);
    const reasons = outlierReasons(months);
    expect(flags.length).toBe(reasons.length);
    for (let i = 0; i < months.length; i++) {
      expect(flags[i]).toBe(reasons[i].length > 0);
    }
  });
});
