import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import ptMessages from '@/i18n/messages/pt-BR.json';
import { ConsolidatedBillCard } from '../ConsolidatedBillCard';

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider
      locale="pt-BR"
      messages={ptMessages as Record<string, unknown>}
      onError={() => {}}
      getMessageFallback={({ key }) => key}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('ConsolidatedBillCard', () => {
  it('renders the principal (non-link) and each additional as a link to its detail', () => {
    wrap(
      <ConsolidatedBillCard
        total={1500}
        breakdown={[
          { cardId: 'p', name: 'C6', color: '#ff8800', total: 1000, isPrincipal: true },
          { cardId: 'c', name: 'C6 - Camila', color: '#00aa00', total: 500, isPrincipal: false },
        ]}
      />,
    );

    expect(screen.getByText('C6')).toBeTruthy();
    expect(screen.getByText('C6 - Camila')).toBeTruthy();

    // Only the additional card is a link; the principal is not.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/credit-cards/c');
  });
});
