import type { ProjectionAlerts } from '@fc/domain';
import { describe, expect, it } from 'vitest';
import { SimulatorAlerts } from '@/components/simulator/SimulatorAlerts';
import { renderWithProviders } from '@/test/render';

describe('SimulatorAlerts', () => {
  const negative: ProjectionAlerts = {
    firstNegativeMonthBaseline: null,
    firstNegativeMonthSimulated: { month: 9, year: 2026 },
    troughBaseline: { month: 6, year: 2026, balance: 500 },
    troughSimulated: { month: 9, year: 2026, balance: -1200 },
  };

  it('shows the simulated overdraft month and the simulated trough', () => {
    const { getByText } = renderWithProviders(<SimulatorAlerts alerts={negative} />);
    expect(getByText(/Simulado fica negativo em set\/2026/)).toBeInTheDocument();
    expect(getByText(/-1\.200,00|1\.200,00/)).toBeInTheDocument();
  });

  it('shows a positive message when the simulated projection never goes negative', () => {
    const positive: ProjectionAlerts = {
      firstNegativeMonthBaseline: null,
      firstNegativeMonthSimulated: null,
      troughBaseline: { month: 6, year: 2026, balance: 800 },
      troughSimulated: { month: 6, year: 2026, balance: 800 },
    };
    const { getByText } = renderWithProviders(<SimulatorAlerts alerts={positive} />);
    expect(getByText('Permanece positivo em todo o horizonte')).toBeInTheDocument();
  });
});
