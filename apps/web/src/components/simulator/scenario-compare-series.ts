import type { ProjectedMonth } from '@fc/domain';

export type CompareScenario = { id: string; name: string; simulated: ProjectedMonth[] };

export type CompareRow = { label: string; sortKey: number } & Record<
  string,
  number | null | string
>;

export type CompareSeries = { id: string; name: string; color: string };

const PALETTE = [
  'oklch(0.62 0.19 255)',
  'oklch(0.7 0.18 150)',
  'oklch(0.72 0.2 50)',
  'oklch(0.65 0.22 330)',
  'oklch(0.68 0.16 200)',
];

function monthLabel(m: number, y: number): string {
  return `${String(m).padStart(2, '0')}/${y}`;
}

export function buildCompareSeries(scenarios: CompareScenario[]): {
  rows: CompareRow[];
  series: CompareSeries[];
} {
  const series: CompareSeries[] = scenarios.map((s, i) => ({
    id: s.id,
    name: s.name,
    color: PALETTE[i % PALETTE.length],
  }));

  const byKey = new Map<number, CompareRow>();
  for (const scenario of scenarios) {
    for (const month of scenario.simulated) {
      const sortKey = month.year * 12 + month.month;
      let row = byKey.get(sortKey);
      if (!row) {
        row = { label: monthLabel(month.month, month.year), sortKey };
        for (const s of scenarios) row[s.id] = null;
        byKey.set(sortKey, row);
      }
      row[scenario.id] = month.endingBalance;
    }
  }

  const rows = Array.from(byKey.values()).sort((a, b) => a.sortKey - b.sortKey);
  return { rows, series };
}
