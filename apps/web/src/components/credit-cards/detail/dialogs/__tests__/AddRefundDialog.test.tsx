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
import { AddRefundDialog } from '../AddRefundDialog';

const rawExtracted = (rawPtMessages as Record<string, unknown>).extracted ?? {};
const nestedExtracted: Record<string, Record<string, string>> = {};
for (const [flatKey, value] of Object.entries(rawExtracted as Record<string, string>)) {
  const dot = flatKey.indexOf('.');
  if (dot === -1) continue;
  const namespace = flatKey.slice(0, dot);
  const leaf = flatKey.slice(dot + 1);
  if (!nestedExtracted[namespace]) nestedExtracted[namespace] = {};
  nestedExtracted[namespace][leaf] = value;
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

describe('AddRefundDialog', () => {
  it('uses creditCard.addRefund, guards the pending form, and closes after success', async () => {
    const refundCalls: Array<{ json?: Record<string, unknown> }> = [];
    const transactionCalls: unknown[] = [];
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    server.use(
      http.post(`${TRPC_URL}/creditCard.addRefund`, async ({ request }) => {
        refundCalls.push((await request.json()) as { json?: Record<string, unknown> });
        await responseGate;
        return HttpResponse.json({
          result: { data: superjson.serialize({ transaction: { id: 'refund-1' } }) },
        });
      }),
      http.post(`${TRPC_URL}/transaction.create`, async ({ request }) => {
        transactionCalls.push(await request.json());
        return HttpResponse.json({ status: 500 });
      }),
    );

    const onOpenChange = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <AddRefundDialog
        open={true}
        onOpenChange={onOpenChange}
        cardId="43615934-d4a9-45ac-83c1-818b31ed7d5a"
        defaultSourceAccountId="e3fc432d-cc2d-4e6a-abe6-df7e36da01fd"
        billMonth={8}
        billYear={2026}
      />,
      { wrapper: makeWrapper(queryClient) },
    );

    fireEvent.change(screen.getByLabelText(/descrição/i), { target: { value: 'Adiantado' } });
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: /adicionar/i }));

    await waitFor(() => expect(refundCalls).toHaveLength(1));
    expect(transactionCalls).toHaveLength(0);
    expect(refundCalls[0]?.json).toMatchObject({
      creditCardAccountId: '43615934-d4a9-45ac-83c1-818b31ed7d5a',
      expenseAccountId: 'e3fc432d-cc2d-4e6a-abe6-df7e36da01fd',
      amount: '1000.00',
      description: 'Adiantado',
      billingMonth: 8,
      billingYear: 2026,
    });
    expect(refundCalls[0]?.json?.refundDate).toBeDefined();

    const cancelButton = screen.getByRole('button', { name: /cancelar/i });
    expect(cancelButton).toBeDisabled();
    fireEvent.click(cancelButton);
    expect(onOpenChange).not.toHaveBeenCalled();

    releaseResponse?.();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
