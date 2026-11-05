import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { obligationFixture } from '@/test/financial-fixtures';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { UpcomingItems } from '../UpcomingItems';

describe('UpcomingItems exact obligations', () => {
  it('exposes the exact occurrence with a textual action, without oldest-installment undo', async () => {
    server.use(
      http.get(`${TRPC_TEST_URL}/dashboard.upcomingObligations`, () =>
        HttpResponse.json({ result: { data: superjson.serialize([obligationFixture]) } }),
      ),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <UpcomingItems />
      </TRPCTestProvider>,
    );
    expect(await screen.findByText(obligationFixture.name)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Registrar pagamento' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Desfazer' })).not.toBeInTheDocument();
  });
  it('shows an empty upcoming window', async () => {
    server.use(
      http.get(`${TRPC_TEST_URL}/dashboard.upcomingObligations`, () =>
        HttpResponse.json({ result: { data: superjson.serialize([]) } }),
      ),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <UpcomingItems />
      </TRPCTestProvider>,
    );
    expect(await screen.findByText(/Nenhum/)).toBeInTheDocument();
  });
});
