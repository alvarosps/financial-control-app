import { describe, expect, it } from 'vitest';

import { OtherExpensesSection } from '@/components/monthly-spending/OtherExpensesSection';
import { renderWithProviders, screen } from '@/test/render';

const expense = {
  id: '1',
  description: 'Presente aniversário',
  amount: '120.00',
  date: '2026-06-15',
  categoryName: null,
  sourceAccountName: 'Itaú',
};

describe('OtherExpensesSection', () => {
  it('uses the spend-other token, never raw hex or rgba hacks', () => {
    const { container } = renderWithProviders(<OtherExpensesSection expenses={[expense]} />);

    expect(container.innerHTML).not.toMatch(/#8b5cf6|rgba\(139/);
    expect(container.innerHTML).toContain('text-spend-other');
  });

  it('renders the amount with the numeric font', () => {
    renderWithProviders(<OtherExpensesSection expenses={[expense]} />);

    const amounts = screen.getAllByText(/120,00/);
    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts[0].className).toContain('font-numeric');
  });

  it('renders nothing when empty', () => {
    const { container } = renderWithProviders(<OtherExpensesSection expenses={[]} />);

    expect(container.innerHTML).toBe('');
  });
});
