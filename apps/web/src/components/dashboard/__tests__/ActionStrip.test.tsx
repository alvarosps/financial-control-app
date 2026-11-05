import { describe, expect, it } from 'vitest';
import { ActionStripView } from '@/components/dashboard/ActionStrip';
import { renderWithProviders } from '@/test/render';

describe('ActionStripView', () => {
  it('renders one link chip per action with plural-aware labels', () => {
    const { getByText } = renderWithProviders(
      <ActionStripView
        chips={[
          { id: 'cardsDue', count: 2 },
          { id: 'billsDue', count: 1 },
          { id: 'incomeCredited', count: 1 },
        ]}
      />,
    );

    expect(getByText('2 faturas vencem em até 7 dias').closest('a')).toHaveAttribute(
      'href',
      '/credit-cards',
    );
    expect(getByText('1 conta vence em até 7 dias').closest('a')).toHaveAttribute('href', '/daily');
    expect(getByText('1 renda creditada hoje').closest('a')).toHaveAttribute('href', '/income');
  });

  it('shows the all-clear line when there are no chips', () => {
    const { getByText } = renderWithProviders(<ActionStripView chips={[]} />);

    expect(getByText('Nada urgente nos próximos 7 dias')).toBeInTheDocument();
  });
});
