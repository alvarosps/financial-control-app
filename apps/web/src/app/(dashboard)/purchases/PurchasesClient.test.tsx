import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { purchaseFixture } from '@/test/purchase-fixture';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { PurchasesClient } from './PurchasesClient';

function renderPage() {
  return renderWithProviders(
    <TRPCTestProvider>
      <PurchasesClient initialDay="2026-09-26" />
    </TRPCTestProvider>,
  );
}
const response = (value: unknown) =>
  HttpResponse.json({ result: { data: superjson.serialize(value) } });

describe('PurchasesClient', () => {
  it('shows one installment purchase with separate estimated impact, source and confirmation and sends day filters', async () => {
    const inputs: Record<string, unknown>[] = [];
    server.use(
      http.get(`${TRPC_TEST_URL}/account.list`, () => response([])),
      http.get(`${TRPC_TEST_URL}/purchaseInbox.list`, ({ request }) => {
        const input = JSON.parse(new URL(request.url).searchParams.get('input') ?? '{}') as {
          json: Record<string, unknown>;
        };
        inputs.push(input.json);
        return response({
          items: [purchaseFixture()],
          nextCursor: null,
          counts: { unreviewed: 1, needs_review: 0, accepted: 0, ignored: 0 },
        });
      }),
    );
    renderPage();
    expect(await screen.findByText('Notebook')).toBeInTheDocument();
    expect(screen.getAllByText('Notebook')).toHaveLength(1);
    expect(screen.getByText('Local card')).toBeInTheDocument();
    expect(screen.getByText('3 parcelas')).toBeInTheDocument();
    expect(screen.getByText('Total estimado')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('Observada')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }));
    await waitFor(() =>
      expect(inputs.at(-1)).toMatchObject({ fromDate: '2026-09-26', toDate: '2026-09-26' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ontem' }));
    await waitFor(() =>
      expect(inputs.at(-1)).toMatchObject({ fromDate: '2026-09-25', toDate: '2026-09-25' }),
    );
    fireEvent.click(screen.getByRole('button', { name: '7 dias' }));
    await waitFor(() =>
      expect(inputs.at(-1)).toMatchObject({ fromDate: '2026-09-20', toDate: '2026-09-26' }),
    );
  });
  it('shows unknown dates without inventing today, paginates and retries failed reads', async () => {
    let failing = true;
    const inputs: Record<string, unknown>[] = [];
    server.use(
      http.get(`${TRPC_TEST_URL}/account.list`, () => response([])),
      http.get(`${TRPC_TEST_URL}/purchaseInbox.list`, ({ request }) => {
        if (failing) return HttpResponse.error();
        const input = JSON.parse(new URL(request.url).searchParams.get('input') ?? '{}') as {
          json: Record<string, unknown>;
        };
        inputs.push(input.json);
        return response({
          items: [
            purchaseFixture({
              id: input.json.cursor
                ? '00000000-0000-4000-8000-000000000011'
                : '00000000-0000-4000-8000-000000000001',
              purchaseDate: null,
              description: input.json.cursor ? 'Segunda compra' : 'Compra sem data',
              application: 'linked',
              appliedAmount: '300.00',
            }),
          ],
          nextCursor: input.json.cursor ? null : '00000000-0000-4000-8000-000000000010',
          counts: { unreviewed: 0, needs_review: 0, accepted: 2, ignored: 0 },
        });
      }),
    );
    renderPage();
    await screen.findByRole('alert');
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByText('Compra sem data');
    fireEvent.click(screen.getByRole('button', { name: 'Sem data' }));
    await waitFor(() => expect(inputs.at(-1)).toMatchObject({ unknownDate: true }));
    expect(screen.getByText('Data desconhecida')).toBeInTheDocument();
    expect(screen.getByText('Já registrado')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('Segunda compra')).toBeInTheDocument();
    expect(inputs.at(-1)?.cursor).toBe('00000000-0000-4000-8000-000000000010');
  });
});
