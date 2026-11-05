import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { LoanBalanceSummary } from '../LoanBalanceSummary';

describe('LoanBalanceSummary', () => {
  const baseProps = {
    current: 5,
    total: 20,
    paid: 5,
    remaining: 15,
    pct: 25,
    monthlyPayment: 850,
    insurance: 0,
    totalMonthly: 850,
    totalRemaining: 12750,
  };

  it('renders the progress numerator/denominator and percent from props', () => {
    renderWithProviders(<LoanBalanceSummary {...baseProps} />);
    expect(screen.getByText(/5 de 20/)).toBeInTheDocument();
    expect(screen.getByText(/^25%$/)).toBeInTheDocument();
  });

  it('hides insurance column when insurance is zero', () => {
    renderWithProviders(<LoanBalanceSummary {...baseProps} />);
    expect(screen.queryByText(/^Seguro$/)).not.toBeInTheDocument();
  });

  it('shows insurance and totalMonthly blocks when insurance > 0', () => {
    renderWithProviders(<LoanBalanceSummary {...baseProps} insurance={120} totalMonthly={970} />);
    expect(screen.getByText(/^Seguro$/)).toBeInTheDocument();
    // formatCurrency for pt-BR renders R$ 120,00 / R$ 970,00 variants.
    expect(screen.getAllByText(/120/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/970/).length).toBeGreaterThan(0);
  });
});
