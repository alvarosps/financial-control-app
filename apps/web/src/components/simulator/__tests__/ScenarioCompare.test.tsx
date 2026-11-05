import type { ProjectedMonth } from '@fc/domain';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ScenarioCompare } from '../ScenarioCompare';
import type { CompareScenario } from '../scenario-compare-series';

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

const SCENARIOS: CompareScenario[] = [
  { id: 'a', name: 'Plano A', simulated: [pm(6, 2026, 100), pm(7, 2026, 200)] },
  { id: 'b', name: 'Plano B', simulated: [pm(6, 2026, 50), pm(7, 2026, 400)] },
];

describe('ScenarioCompare', () => {
  it('renders a chart container with both scenario names in the legend', () => {
    const { container, getByText } = renderWithProviders(<ScenarioCompare scenarios={SCENARIOS} />);
    expect(container.querySelector('[data-slot="chart"]')).toBeTruthy();
    expect(getByText('Plano A')).toBeTruthy();
    expect(getByText('Plano B')).toBeTruthy();
  });

  it('shows an empty hint when fewer than two scenarios are selected', () => {
    const { getByText, container } = renderWithProviders(
      <ScenarioCompare scenarios={[SCENARIOS[0]]} />,
    );
    expect(container.querySelector('[data-slot="chart"]')).toBeNull();
    expect(getByText(/selecione|select/i)).toBeTruthy();
  });

  it('renders the chart when scenarios cover misaligned month ranges (gap → null)', () => {
    // Plano B starts a month later, so the merged series leaves a leading null
    // gap for B. The tooltip formatter renders `—` for that null instead of
    // R$ 0,00; here we assert the misaligned overlay still mounts both series.
    const misaligned: CompareScenario[] = [
      { id: 'a', name: 'Plano A', simulated: [pm(6, 2026, 100), pm(7, 2026, 200)] },
      { id: 'b', name: 'Plano B', simulated: [pm(7, 2026, 400)] },
    ];
    const { container, getByText } = renderWithProviders(
      <ScenarioCompare scenarios={misaligned} />,
    );
    expect(container.querySelector('[data-slot="chart"]')).toBeTruthy();
    expect(getByText('Plano A')).toBeTruthy();
    expect(getByText('Plano B')).toBeTruthy();
  });
});
