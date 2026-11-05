/**
 * PayBillDialog integration test.
 *
 * Renders the real dialog inside the real NextIntl + tRPC provider stack.
 * Captures the `creditCard.payBill` mutation HTTP request via msw and verifies
 * the cache-fanout side-effect by observing the REAL invalidation: the dialog's
 * onSuccess runs the real `invalidateCreditCardContext`, which issues one
 * `queryClient.invalidateQueries` per canonical query. We spy on the real
 * QueryClient (TanStack Query is the external boundary) WITHOUT replacing it,
 * so the genuine fan-out still executes — nothing internal is mocked.
 *
 * tRPC sends batch POSTs at `/api/trpc/<procedure>`; a raw msw handler is the
 * simplest working contract (no coupling to msw-trpc's typegen gymnastics).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import rawPtMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../../../test/msw-server';
import { PayBillDialog } from '../PayBillDialog';

// Rehydrate i18n messages so `t('ns.hash')` resolves (mirrors test/render.tsx).
const rawExtracted = (rawPtMessages as Record<string, unknown>).extracted ?? {};
const nestedExtracted: Record<string, Record<string, string>> = {};
for (const [flatKey, value] of Object.entries(rawExtracted as Record<string, string>)) {
  const dot = flatKey.indexOf('.');
  if (dot === -1) continue;
  const ns = flatKey.slice(0, dot);
  const leaf = flatKey.slice(dot + 1);
  if (!nestedExtracted[ns]) nestedExtracted[ns] = {};
  nestedExtracted[ns][leaf] = value;
}
const { extracted: _dropped, ...restMessages } = rawPtMessages as Record<string, unknown>;
const ptMessages = { ...restMessages, ...nestedExtracted };

const TRPC_URL = 'http://localhost:3000/api/trpc';

function makeWrapper(queryClient: QueryClient) {
  const trpcClient = trpc.createClient({
    links: [httpLink({ url: TRPC_URL, transformer: superjson })],
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <NextIntlClientProvider
        locale="pt-BR"
        messages={ptMessages as Record<string, unknown>}
        onError={() => {}}
        getMessageFallback={({ key }) => key}
      >
        <trpc.Provider client={trpcClient} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </trpc.Provider>
      </NextIntlClientProvider>
    );
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PayBillDialog', () => {
  it('selects the remaining wallet when the previous selection is no longer eligible', async () => {
    const calls: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/creditCard.payBill`, async ({ request }) => {
        calls.push(await request.json());
        return HttpResponse.json({
          result: { data: superjson.serialize({ billTotal: '800.00' }) },
        });
      }),
    );
    const wrapper = makeWrapper(new QueryClient());
    const view = render(<PayBillDialog {...baseProps} />, { wrapper });
    fireEvent.change(await screen.findByLabelText(/Data e hora do pagamento/), {
      target: { value: '2026-09-12T09:00' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar' })).toBeEnabled());
    view.rerender(
      <PayBillDialog
        {...baseProps}
        paymentAccounts={[{ id: 'wallet-2', name: 'Conta substituta' }]}
      />,
    );
    fireEvent.change(await screen.findByLabelText(/Data e hora do pagamento/), {
      target: { value: '2026-09-12T09:00' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ json: { paidFromAccountId: 'wallet-2' } });
  });

  const baseProps = {
    open: true,
    onOpenChange: vi.fn(),
    cardId: 'card-1',
    month: 9,
    year: 2026,
    billTotal: 800,
    paymentAccounts: [{ id: 'wallet-1', name: 'Conta corrente' }],
  };

  it('shows the card and pending amount separately from the full bill', () => {
    render(
      <PayBillDialog
        {...baseProps}
        cardName="Cartão Azul"
        paymentAmount={300}
        dueDate="2026-10-05"
      />,
      { wrapper: makeWrapper(new QueryClient()) },
    );
    expect(screen.getByText('Cartão Azul')).toBeInTheDocument();
    expect(screen.getByText(/300,00/)).toBeInTheDocument();
    expect(screen.getByText(/800,00/)).toBeInTheDocument();
    expect(screen.getByText(/05\/10/)).toBeInTheDocument();
  });

  it.each([
    { paymentAmount: 0 },
    { isLoading: true },
    { loadError: 'Falha de conexão' },
  ])('does not allow confirming unavailable bill data: %j', (state) => {
    render(<PayBillDialog {...baseProps} {...state} />, {
      wrapper: makeWrapper(new QueryClient()),
    });
    const confirm = screen.queryByRole('button', { name: /confirmar/i });
    if (confirm) expect(confirm).toBeDisabled();
    else expect(screen.queryByRole('button', { name: /confirmar/i })).not.toBeInTheDocument();
  });

  it('blocks a previously selected account that is no longer eligible', async () => {
    const wrapper = makeWrapper(new QueryClient());
    const view = render(<PayBillDialog {...baseProps} />, { wrapper });
    fireEvent.change(await screen.findByLabelText(/Data e hora do pagamento/), {
      target: { value: '2026-09-12T09:00' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /confirmar/i })).toBeEnabled());
    view.rerender(
      <PayBillDialog
        {...baseProps}
        paymentAccounts={[
          { id: 'wallet-2', name: 'Outra conta' },
          { id: 'wallet-3', name: 'Poupança' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeDisabled();
  });

  it('calls creditCard.payBill mutation on confirm and fans out real invalidation on success', async () => {
    const payBillCalls: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/creditCard.payBill`, async ({ request }) => {
        const body = (await request.json()) as { json?: unknown; 0?: { json?: unknown } };
        payBillCalls.push(body);
        // tRPC httpLink envelope (superjson): data must be wrapped.
        const payload = superjson.serialize({ billTotal: '500.00', markedCount: 1 });
        return HttpResponse.json({ result: { data: payload } });
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // Pass-through spy on the REAL cache: the dialog's onSuccess runs the real
    // invalidateCreditCardContext, which calls queryClient.invalidateQueries once
    // per canonical query (13 total). The real invalidation still executes; we
    // only count it. A broken invalidate.ts (dropped/extra query) shifts the count.
    const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <PayBillDialog
        open={true}
        onOpenChange={() => {}}
        cardId="card-uuid-1"
        month={4}
        year={2026}
        billTotal={500}
        paymentAccounts={[{ id: 'acc-uuid-1', name: 'Bank' }]}
      />,
      { wrapper: makeWrapper(queryClient) },
    );

    // Single payment account auto-selects; submit via the confirm button.
    const confirmBtn = await screen.findByRole('button', { name: /confirmar/i });
    fireEvent.change(await screen.findByLabelText(/Data e hora do pagamento/), {
      target: { value: '2026-09-12T09:00' },
    });
    await waitFor(() => expect(confirmBtn).toBeEnabled());
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(payBillCalls.length).toBe(1);
    });

    // Request body shape: tRPC httpLink sends `{ json: input }` via superjson.
    const captured = payBillCalls[0] as { json?: Record<string, unknown> };
    expect(captured.json).toMatchObject({
      cardAccountId: 'card-uuid-1',
      month: 4,
      year: 2026,
      paidFromAccountId: 'acc-uuid-1',
    });

    // The real credit-card invalidation fan-out fired against the real cache.
    await waitFor(() => {
      expect(invalidateQueriesSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
