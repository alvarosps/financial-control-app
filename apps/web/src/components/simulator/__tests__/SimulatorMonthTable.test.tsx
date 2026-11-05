import type { ProjectedMonth } from '@fc/domain';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SimulatorMonthTable } from '@/components/simulator/SimulatorMonthTable';
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

describe('SimulatorMonthTable', () => {
  const baseline: ProjectedMonth[] = [
    month({
      month: 6,
      year: 2026,
      openingBalance: 1000,
      income: { base: 5000, familyLoan: 0, lever: 0, total: 5000 },
      expenses: { creditCard: 3000, loan: 0, charge: 0, other: 0, lever: 0, total: 3000 },
      net: 2000,
      endingBalance: 3000,
    }),
  ];
  const simulated: ProjectedMonth[] = [
    month({
      month: 6,
      year: 2026,
      openingBalance: 1000,
      income: { base: 5000, familyLoan: 0, lever: 0, total: 5000 },
      expenses: { creditCard: 3000, loan: 0, charge: 0, other: 0, lever: 7000, total: 10000 },
      net: -5000,
      endingBalance: -4000,
    }),
  ];

  it('renders the column headers and the baseline view by default', () => {
    const { getByText, getByRole } = renderWithProviders(
      <SimulatorMonthTable baseline={baseline} simulated={simulated} />,
    );
    expect(getByRole('columnheader', { name: 'Mês' })).toBeInTheDocument();
    expect(getByRole('columnheader', { name: 'Inicial' })).toBeInTheDocument();
    expect(getByRole('columnheader', { name: 'Renda própria antes da folha' })).toBeInTheDocument();
    expect(getByRole('columnheader', { name: 'Despesas' })).toBeInTheDocument();
    expect(getByRole('columnheader', { name: 'Líquido' })).toBeInTheDocument();
    expect(getByRole('columnheader', { name: 'Final' })).toBeInTheDocument();
    // Unified monthYearLabel strips the pt-BR trailing dot (e.g. "jun/2026").
    expect(getByText('jun/2026')).toBeInTheDocument();
    // Baseline row carries its net (+2.000,00) and ending (+3.000,00) values.
    const row = getByRole('row', { name: /jun\/2026/i });
    expect(row).toHaveTextContent('2.000,00');
    expect(row).toHaveTextContent('3.000,00');
  });

  it('keeps the baseline (non-negative) row unflagged by default', () => {
    const { getByRole } = renderWithProviders(
      <SimulatorMonthTable baseline={baseline} simulated={simulated} />,
    );
    const row = getByRole('row', { name: /jun\/2026/i });
    expect(row).toHaveAttribute('data-negative', 'false');
  });

  it('switches to the simulated view and flags the negative ending row', () => {
    const { getByRole } = renderWithProviders(
      <SimulatorMonthTable baseline={baseline} simulated={simulated} />,
    );
    fireEvent.click(getByRole('tab', { name: 'Simulado' }));
    const negativeRow = getByRole('row', { name: /jun\/2026/i });
    expect(negativeRow).toHaveAttribute('data-negative', 'true');
    // Simulated ending balance is -4.000,00.
    expect(getByRole('row', { name: /4\.000,00/ })).toBeInTheDocument();
  });
});
