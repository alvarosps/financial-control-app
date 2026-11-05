import { describe, expect, it } from 'vitest';
import { SpendingSummary } from '@/components/monthly-spending/SpendingSummary';
import { renderWithProviders } from '@/test/render';

const summary = {
  total: '1200',
  byType: {
    creditCards: { total: '300', count: 1, itemCount: 1 },
    grocery: { total: '100', count: 1, itemCount: 1 },
    storeCards: { total: '0', count: 0, itemCount: 0 },
    marketplaceLoans: { total: '0', count: 0, itemCount: 0 },
    vehicle: { total: '0', count: 0, itemCount: 0 },
    loans: { total: '500', count: 1 },
    fixedExpenses: { total: '300', count: 1 },
    other: { total: '0', count: 0 },
  },
  newInstallments: { total: '120', count: 2 },
  oneTimeExpenses: { total: '80', count: 1 },
};

describe('SpendingSummary', () => {
  it('leads with the month total KPI and keeps the distribution accessible', () => {
    const { getByText, getByRole } = renderWithProviders(<SpendingSummary summary={summary} />);

    expect(getByText('Total')).toBeInTheDocument();
    expect(getByText('R$ 1.200,00')).toHaveClass('text-3xl', 'font-numeric', 'tabular-nums');
    expect(
      getByRole('img', { name: 'Distribui\u00e7\u00e3o de gastos: total R$ 1.200,00' }),
    ).toBeInTheDocument();
  });

  it('uses the spending token instead of an inline color for one-off expenses', () => {
    const { getByText } = renderWithProviders(<SpendingSummary summary={summary} />);

    expect(
      getByText('Gastos \u00danicos').parentElement?.querySelector('.text-spend-other'),
    ).toBeInTheDocument();
  });
});
