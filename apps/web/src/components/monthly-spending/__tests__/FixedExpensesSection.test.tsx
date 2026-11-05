import { describe, expect, it } from 'vitest';

import { FixedExpensesSection } from '@/components/monthly-spending/FixedExpensesSection';
import { renderWithProviders, screen } from '@/test/render';

const expense = {
  id: '1',
  description: 'Netflix',
  amount: '55.90',
  source: 'Nubank',
  categoryName: null,
  fixedCategory: 'assinatura' as const,
};

describe('FixedExpensesSection', () => {
  it('uses the info token, never hardcoded blue', () => {
    const { container } = renderWithProviders(<FixedExpensesSection expenses={[expense]} />);

    expect(container.innerHTML).not.toMatch(/blue-500/);
    expect(container.innerHTML).toContain('text-info');
  });

  it('renders the section total with the numeric font', () => {
    renderWithProviders(<FixedExpensesSection expenses={[expense]} />);

    const totals = screen.getAllByText(/55,90/);
    expect(totals.length).toBeGreaterThan(0);
    expect(totals[0].className).toContain('font-numeric');
  });

  it('renders nothing when empty', () => {
    const { container } = renderWithProviders(<FixedExpensesSection expenses={[]} />);

    expect(container.innerHTML).toBe('');
  });
});
