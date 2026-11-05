// packages/domain/src/spend-outliers.ts

/**
 * Pure detection of "atypical" spend months, used by `MonthlyAveragesService`
 * to exclude one-off spikes (e.g. a Europe trip) from a typical monthly average.
 *
 * Two independent, robust signals — a month is atypical if EITHER fires:
 *
 * 1. Statistical (median + MAD): we use the median and the Median Absolute
 *    Deviation rather than mean/standard-deviation because a single large spike
 *    drags the mean (and inflates the variance) enough to mask itself, whereas
 *    the median/MAD are resistant to outliers. A month is flagged when its
 *    distance from the median exceeds `k * MAD` (default k = 3.5, the common
 *    "modified z-score" cutoff). This needs a minimum number of months to be
 *    meaningful (default 4) and is skipped entirely when MAD is 0 (all totals
 *    equal — no spread, so nothing can be an outlier).
 *
 * 2. IOF trip-signal: any month carrying more than `iofThreshold` BRL of IOF
 *    (the Brazilian tax levied on foreign-currency card spend) almost always
 *    reflects international/travel spend, so it is treated as atypical on its
 *    own — even when too few months exist for the statistical test to fire.
 *
 * Totals/IOF here are already-rounded BRL numbers produced by the summary layer.
 * This is detection (comparison/thresholding), not money accumulation, so plain
 * `number` arithmetic is correct — no `Money` value object is needed.
 */

export type OutlierInput = { total: number; iof: number };
export type OutlierOptions = {
  k?: number; // MAD multiplier (default 3.5)
  minData?: number; // min months for the statistical test (default 4)
  iofThreshold?: number; // BRL IOF above which a month is atypical (default 10)
};

// k = 3.5 is the common "modified z-score" cutoff; minData = 4 is the smallest
// sample for which the median/MAD test is meaningful; iofThreshold = 10 BRL of
// IOF reliably indicates international/travel spend. See the module docstring.
const DEFAULT_K = 3.5;
const DEFAULT_MIN_DATA = 4;
const DEFAULT_IOF_THRESHOLD = 10;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Resolves option defaults and computes the median/MAD statistical context once,
 * so both `detectOutlierMonths` and `outlierReasons` share a single pass.
 */
function computeOutlierContext(
  months: OutlierInput[],
  opts: OutlierOptions,
): { canStat: boolean; med: number; mad: number; k: number; iofThreshold: number } {
  const k = opts.k ?? DEFAULT_K;
  const minData = opts.minData ?? DEFAULT_MIN_DATA;
  const iofThreshold = opts.iofThreshold ?? DEFAULT_IOF_THRESHOLD;
  const totals = months.map((m) => m.total);
  const med = median(totals);
  const mad = median(totals.map((t) => Math.abs(t - med)));
  const canStat = months.length >= minData && mad > 0;
  return { canStat, med, mad, k, iofThreshold };
}

/** Returns a boolean per input month: true = atypical (exclude from the typical average). */
export function detectOutlierMonths(months: OutlierInput[], opts: OutlierOptions = {}): boolean[] {
  const { canStat, med, mad, k, iofThreshold } = computeOutlierContext(months, opts);
  return months.map((m) => {
    const stat = canStat && Math.abs(m.total - med) > k * mad;
    const iof = m.iof > iofThreshold;
    return stat || iof;
  });
}

/** Same, but returns the reason tags per flagged month (for reporting). */
export function outlierReasons(
  months: OutlierInput[],
  opts: OutlierOptions = {},
): Array<Array<'statistical' | 'iof'>> {
  const { canStat, med, mad, k, iofThreshold } = computeOutlierContext(months, opts);
  return months.map((m) => {
    const r: Array<'statistical' | 'iof'> = [];
    if (canStat && Math.abs(m.total - med) > k * mad) r.push('statistical');
    if (m.iof > iofThreshold) r.push('iof');
    return r;
  });
}
