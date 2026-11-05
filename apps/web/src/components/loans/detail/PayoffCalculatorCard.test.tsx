import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PayoffCalculatorCard } from './PayoffCalculatorCard';

describe('PayoffCalculatorCard', () => {
  it('shows missing contractual evidence and does not recommend unreconciled cash', () => {
    renderWithProviders(
      <PayoffCalculatorCard
        totalRemaining={100}
        payoff={{
          totalIfPaying: '100.00',
          outstandingBalance: '100.00',
          savings: '0.00',
          savingsPercent: 0,
          annualCet: null,
          monthlyNominalRate: '0.00',
          payoffQuote: {
            status: 'missing',
            quotedAmount: null,
            source: null,
            quotedOn: null,
            validUntil: null,
          },
          monthlyRelease: '100.00',
          payrollRelease: '100.00',
          bankRelease: '0.00',
          economicResponsibility: 'family',
          cashReady: false,
          availableCash: null,
          exceedsAvailableCash: null,
        }}
      />,
    );
    expect(screen.getByText('CET anual não informado')).toBeInTheDocument();
    expect(screen.getByText('Cotação não informada')).toBeInTheDocument();
    expect(screen.getByText(/Caixa ainda não conciliado/)).toBeInTheDocument();
    expect(screen.getByText(/Responsável econômico: Familiar/)).toBeInTheDocument();
  });
});
