import { describe, expect, it } from 'vitest';

import { LoansSection } from '@/components/monthly-spending/LoansSection';
import { renderWithProviders, screen } from '@/test/render';

const loan = {
  accountId: 'a1',
  name: 'Financiamento Carro',
  installmentNumber: 12,
  totalInstallments: 48,
  loanType: 'pessoal',
  monthlyPayment: '850.00',
  originalAmount: '40000.00',
  monthlyInterestRate: 0.015,
  annualInterestRate: 0.1956,
};

describe('LoansSection', () => {
  it('renders via CollapsibleSpendingSection: heading font, warning tone, no raw palette', () => {
    const { container } = renderWithProviders(<LoansSection loans={[loan]} />);

    expect(container.innerHTML).toContain('font-heading');
    expect(container.innerHTML).toContain('text-warning');
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}|rgba\(|orange-|yellow-/);
  });

  it('renders the monthly payment with the numeric font', () => {
    renderWithProviders(<LoansSection loans={[loan]} />);

    const amounts = screen.getAllByText(/850,00/);
    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts[0].className).toContain('font-numeric');
  });

  it('renders nothing when empty', () => {
    const { container } = renderWithProviders(<LoansSection loans={[]} />);

    expect(container.innerHTML).toBe('');
  });
});
