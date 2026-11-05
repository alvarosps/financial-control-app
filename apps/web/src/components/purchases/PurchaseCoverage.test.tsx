import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PurchaseCoverage, type PurchaseCoverageData } from './PurchaseCoverage';

const coverage: PurchaseCoverageData = {
  cardAccountId: '00000000-0000-4000-8000-000000000002',
  cardName: 'Local card',
  state: 'partial',
  pending: 2,
  lastReconciledCycle: {
    cardAccountId: '00000000-0000-4000-8000-000000000002',
    month: 8,
    year: 2026,
    closingDate: '2026-08-24',
    appliedAt: new Date('2026-09-25T12:00:00Z'),
    confidence: 'confirmed',
    status: 'reconciled',
    estimated: false,
    future: false,
  },
  sources: [
    {
      source: 'manual',
      active: true,
      state: 'partial',
      lastEventReceivedAt: new Date('2026-09-26T12:00:00Z'),
      lastImportAppliedAt: null,
      lastSuccessfulFetchAt: null,
      providerUpdatedAt: null,
      coveredFrom: null,
      coveredThrough: null,
      error: null,
    },
    {
      source: 'pdf',
      active: true,
      state: 'error',
      lastEventReceivedAt: null,
      lastImportAppliedAt: new Date('2026-09-25T12:00:00Z'),
      lastSuccessfulFetchAt: null,
      providerUpdatedAt: null,
      coveredFrom: null,
      coveredThrough: '2026-08-24',
      error: 'reconciliation_difference',
    },
    {
      source: 'pluggy',
      active: false,
      state: 'disabled',
      lastEventReceivedAt: null,
      lastImportAppliedAt: null,
      lastSuccessfulFetchAt: null,
      providerUpdatedAt: null,
      coveredFrom: null,
      coveredThrough: null,
      error: null,
    },
  ],
};
describe('PurchaseCoverage', () => {
  it('distinguishes a receipt and a reconciled past PDF cycle from provider synchronization', () => {
    renderWithProviders(<PurchaseCoverage coverage={coverage} />);
    expect(screen.getAllByText(/Cobertura parcial/).length).toBeGreaterThan(0);
    expect(screen.getByText('Último ciclo conciliado: 08/2026.')).toBeInTheDocument();
    expect(screen.getByText(/não comprova que a fatura aberta/)).toBeInTheDocument();
    expect(screen.getByText(/Diferença na conciliação/)).toBeInTheDocument();
    expect(screen.getByText(/Fonte desativada/)).toBeInTheDocument();
    expect(screen.getAllByText(/Consulta ao banco não comprovada/)).toHaveLength(3);
    expect(screen.getByText('2 para revisar')).toBeInTheDocument();
  });
  it.each([
    'no_data',
    'stale',
  ] as const)('does not imply zero spending or a synced card in state %s', (state) => {
    renderWithProviders(
      <PurchaseCoverage
        coverage={{ ...coverage, state, sources: [], lastReconciledCycle: null }}
        compact
      />,
    );
    expect(
      screen.getByText(state === 'stale' ? 'Sem evidência recente' : 'Sem dados de cobertura'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver compras' })).toHaveAttribute(
      'href',
      `/purchases?card=${coverage.cardAccountId}`,
    );
  });
});
