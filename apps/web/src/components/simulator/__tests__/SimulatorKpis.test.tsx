import type { SavingsGoal } from '@fc/domain';
import { describe, expect, it } from 'vitest';
import { SimulatorKpis } from '@/components/simulator/SimulatorKpis';
import { renderWithProviders } from '@/test/render';

describe('SimulatorKpis', () => {
  const kpis = {
    openingNow: 1000,
    endingBaseline: 2500,
    endingSimulated: 4000,
    delta: 1500,
  };

  it('renders the five KPI labels and the simulated ending value', () => {
    const { getByText } = renderWithProviders(<SimulatorKpis kpis={kpis} firstOverdraft={null} />);
    expect(getByText('Saldo atual')).toBeInTheDocument();
    expect(getByText('Final base')).toBeInTheDocument();
    expect(getByText('Final simulado')).toBeInTheDocument();
    expect(getByText('Efeito líquido')).toBeInTheDocument();
    expect(getByText('Primeiro saldo negativo')).toBeInTheDocument();
    // R$ 4.000,00 — formatCurrency(4000) (non-breaking space normalized to a plain space)
    expect(getByText(/4\.000,00/)).toBeInTheDocument();
  });

  it('shows "Nenhum" when there is no overdraft month', () => {
    const { getByText } = renderWithProviders(<SimulatorKpis kpis={kpis} firstOverdraft={null} />);
    expect(getByText('Nenhum')).toBeInTheDocument();
  });

  it('shows the overdraft month label when present', () => {
    const { getByText } = renderWithProviders(
      <SimulatorKpis kpis={kpis} firstOverdraft={{ month: 8, year: 2026 }} />,
    );
    expect(getByText('ago/2026')).toBeInTheDocument();
  });

  it('does not render a savings-goal tile when the prop is absent', () => {
    const { queryByText } = renderWithProviders(
      <SimulatorKpis kpis={kpis} firstOverdraft={null} />,
    );
    expect(queryByText('Aporte mensal necessário')).not.toBeInTheDocument();
  });

  it('renders the savings-goal tile with the required monthly amount when feasible', () => {
    const savingsGoal: SavingsGoal = {
      requiredMonthly: 750,
      projectedAtTarget: 9000,
      feasible: true,
      beyondHorizon: false,
    };
    const { getByText } = renderWithProviders(
      <SimulatorKpis kpis={kpis} firstOverdraft={null} savingsGoal={savingsGoal} />,
    );
    expect(getByText('Aporte mensal necessário')).toBeInTheDocument();
    expect(getByText(/750,00/)).toBeInTheDocument();
    expect(getByText('Viável')).toBeInTheDocument();
  });

  it('renders the savings-goal tile as not feasible when the goal is out of reach', () => {
    const savingsGoal: SavingsGoal = {
      requiredMonthly: 5000,
      projectedAtTarget: 1000,
      feasible: false,
      beyondHorizon: false,
    };
    const { getByText } = renderWithProviders(
      <SimulatorKpis kpis={kpis} firstOverdraft={null} savingsGoal={savingsGoal} />,
    );
    expect(getByText('Aporte mensal necessário')).toBeInTheDocument();
    expect(getByText('Inviável')).toBeInTheDocument();
  });
});
