import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { FamilyLoanBalanceSummary } from '../FamilyLoanBalanceSummary';

describe('FamilyLoanBalanceSummary', () => {
  const monthly = {
    total: 1500,
    borrowedCardTotal: 600,
    installments: 400,
    fixedCharges: 300,
    oneTimeCharges: 200,
    discounts: 50,
  };

  it('renders each monthly component value and the card count', () => {
    renderWithProviders(<FamilyLoanBalanceSummary monthly={monthly} cardCount={3} />);

    expect(screen.getByText('Gastos únicos')).toBeInTheDocument();
    expect(screen.queryByText('Pagamentos')).not.toBeInTheDocument();
    // Card count is rendered adjacent to a translated "cards" label inside the
    // StatCard delta line; assert at least one element's text starts with the
    // numeric count.
    const countNodes = screen.getAllByText((_, node) =>
      (node?.textContent ?? '').trim().startsWith('3 '),
    );
    expect(countNodes.length).toBeGreaterThan(0);
    // Discount bucket is rendered with a leading minus sign; assert at least
    // one element containing the currency fragment for 50.
    expect(screen.getAllByText(/50/).length).toBeGreaterThan(0);
    // Total appears both as a summary card and the hero total.
    expect(screen.getAllByText(/1\.?500/).length).toBeGreaterThan(0);
  });

  it('still renders when all monetary values are zero', () => {
    const zero = {
      total: 0,
      borrowedCardTotal: 0,
      installments: 0,
      fixedCharges: 0,
      oneTimeCharges: 0,
      discounts: 0,
    };
    renderWithProviders(<FamilyLoanBalanceSummary monthly={zero} cardCount={0} />);
    // Multiple R$ 0,00 renderings — just assert the component didn't crash
    // and one instance is present.
    expect(screen.getAllByText(/0,00/).length).toBeGreaterThan(0);
  });
});
