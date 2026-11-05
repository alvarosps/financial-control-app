import type { ProjectedMonth } from '@fc/domain';
import { describe, expect, it } from 'vitest';
import {
  buildRunningBalanceData,
  RunningBalanceChart,
} from '@/components/simulator/RunningBalanceChart';
import { renderWithProviders } from '@/test/render';

function month(over: Partial<ProjectedMonth>): ProjectedMonth {
  return {
    month: 1,
    year: 2026,
    openingBalance: 0,
    income: { base: 0, familyLoan: 0, lever: 0, total: 0 },
    expenses: { creditCard: 0, loan: 0, charge: 0, other: 0, lever: 0, total: 0 },
    net: 0,
    endingBalance: 0,
    events: [],
    ...over,
  };
}

const baseline: ProjectedMonth[] = [
  month({ month: 6, year: 2026, endingBalance: 1000 }),
  month({ month: 7, year: 2026, endingBalance: 1500 }),
];
const simulated: ProjectedMonth[] = [
  month({ month: 6, year: 2026, endingBalance: 1200 }),
  month({ month: 7, year: 2026, endingBalance: 2200 }),
];

describe('buildRunningBalanceData', () => {
  it('zips baseline and simulated ending balances per month', () => {
    const data = buildRunningBalanceData(baseline, simulated);
    // monthYearLabel(s, 2) strips the pt-BR trailing dot and uses a 2-digit year.
    expect(data).toEqual([
      { name: 'jun/26', baseline: 1000, simulated: 1200 },
      { name: 'jul/26', baseline: 1500, simulated: 2200 },
    ]);
  });

  it('derives the X axis from the simulated horizon and falls back to 0', () => {
    const data = buildRunningBalanceData([], simulated);
    expect(data.map((d) => d.name)).toEqual(['jun/26', 'jul/26']);
    expect(data.every((d) => d.baseline === 0)).toBe(true);
  });
});

describe('RunningBalanceChart', () => {
  it('renders the chart title', () => {
    const { getByText } = renderWithProviders(
      <RunningBalanceChart baseline={baseline} simulated={simulated} />,
    );
    expect(getByText('Saldo acumulado')).toBeInTheDocument();
  });

  it('renders inside a chart container surface', () => {
    const { container } = renderWithProviders(
      <RunningBalanceChart baseline={baseline} simulated={simulated} />,
    );
    // recharts ResponsiveContainer collapses to 0x0 in jsdom, so assert on the
    // ChartContainer slot rather than the (unrendered) recharts surface.
    expect(container.querySelector('[data-slot="chart"]')).toBeInTheDocument();
  });

  it('injects baseline/simulated color vars from the chart config', () => {
    const { container } = renderWithProviders(
      <RunningBalanceChart baseline={baseline} simulated={simulated} />,
    );
    const style = container.querySelector('style');
    expect(style?.innerHTML).toContain('--color-baseline:');
    expect(style?.innerHTML).toContain('--color-simulated:');
  });

  it('renders without crashing when an optional target line is provided', () => {
    const { getByText } = renderWithProviders(
      <RunningBalanceChart
        baseline={baseline}
        simulated={simulated}
        targetLine={{ value: 2000, label: 'Meta' }}
      />,
    );
    // The target line is a recharts ReferenceLine (not rendered in jsdom); the
    // component still mounts and shows its title with the prop present.
    expect(getByText('Saldo acumulado')).toBeInTheDocument();
  });
});
