import type { ProjectedMonth } from '@fc/domain';
import { describe, expect, it } from 'vitest';
import { buildCompareSeries, type CompareScenario } from '../scenario-compare-series';

function pm(month: number, year: number, ending: number): ProjectedMonth {
  return {
    month,
    year,
    openingBalance: 0,
    income: { base: 0, familyLoan: 0, lever: 0, total: 0 },
    expenses: { creditCard: 0, loan: 0, charge: 0, other: 0, lever: 0, total: 0 },
    net: ending,
    endingBalance: ending,
    events: [],
  };
}

const A: CompareScenario = {
  id: 'a',
  name: 'Plano A',
  simulated: [pm(6, 2026, 100), pm(7, 2026, 200)],
};
const B: CompareScenario = {
  id: 'b',
  name: 'Plano B',
  simulated: [pm(7, 2026, 500), pm(8, 2026, 800)],
};

describe('buildCompareSeries', () => {
  it('returns one row per distinct month, ordered chronologically', () => {
    const { rows } = buildCompareSeries([A, B]);
    expect(rows.map((r) => r.label)).toEqual(['06/2026', '07/2026', '08/2026']);
  });

  it('keys each scenario ending balance by scenario id and fills gaps with null', () => {
    const { rows } = buildCompareSeries([A, B]);
    expect(rows[0]).toMatchObject({ label: '06/2026', a: 100, b: null });
    expect(rows[1]).toMatchObject({ label: '07/2026', a: 200, b: 500 });
    expect(rows[2]).toMatchObject({ label: '08/2026', a: null, b: 800 });
  });

  it('returns the scenario id/name/color legend', () => {
    const { series } = buildCompareSeries([A, B]);
    expect(series.map((s) => s.id)).toEqual(['a', 'b']);
    expect(series.map((s) => s.name)).toEqual(['Plano A', 'Plano B']);
    expect(series.every((s) => typeof s.color === 'string')).toBe(true);
  });
});
