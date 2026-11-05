import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import rawPtMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../test/msw-server';
import { AddDiscountDialog } from '../AddDiscountDialog';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

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
const CONFIG_ID = '22222222-2222-2222-2222-222222222222';

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const trpcClient = trpc.createClient({
    links: [httpLink({ url: TRPC_URL, transformer: superjson })],
  });
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
}

afterEach(() => {
  vi.restoreAllMocks();
});

function fillBaseFields() {
  fireEvent.change(screen.getByLabelText(/descri/i), { target: { value: 'Desconto' } });
  fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '50' } });
  fireEvent.click(screen.getByLabelText(/parcelar desconto/i));
  fireEvent.change(screen.getByLabelText(/data de in.cio/i), { target: { value: '2026-06-10' } });
  fireEvent.change(screen.getByLabelText(/total de parcelas/i), { target: { value: '6' } });
  fireEvent.change(screen.getByLabelText(/dia de vencimento/i), { target: { value: '10' } });
}

describe('AddDiscountDialog', () => {
  it('sends currentInstallment and never startingOccurrence in the mutation payload', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post(`${TRPC_URL}/familyLoan.addDiscount`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    render(
      <AddDiscountDialog
        open={true}
        onOpenChange={() => {}}
        configId={CONFIG_ID}
        onSuccess={() => {}}
      />,
      { wrapper: TestWrapper },
    );

    fillBaseFields();
    fireEvent.change(screen.getByLabelText(/parcela atual/i), { target: { value: '3' } });

    const form = screen.getByLabelText(/descri/i).closest('form');
    if (!form) throw new Error('expected form');
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].json).toMatchObject({
      configId: CONFIG_ID,
      totalInstallments: 6,
      currentInstallment: 3,
      dueDay: 10,
    });
    expect(calls[0].json).not.toHaveProperty('startingOccurrence');
  });

  it('blocks submit when currentInstallment is greater than totalInstallments', async () => {
    const calls: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/familyLoan.addDiscount`, async ({ request }) => {
        calls.push(await request.json());
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    render(
      <AddDiscountDialog
        open={true}
        onOpenChange={() => {}}
        configId={CONFIG_ID}
        onSuccess={() => {}}
      />,
      { wrapper: TestWrapper },
    );

    fillBaseFields();
    fireEvent.change(screen.getByLabelText(/parcela atual/i), { target: { value: '9' } });

    const form = screen.getByLabelText(/descri/i).closest('form');
    if (!form) throw new Error('expected form');
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
  });

  it('blocks submit when currentInstallment is empty', async () => {
    const calls: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/familyLoan.addDiscount`, async ({ request }) => {
        calls.push(await request.json());
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    render(
      <AddDiscountDialog
        open={true}
        onOpenChange={() => {}}
        configId={CONFIG_ID}
        onSuccess={() => {}}
      />,
      { wrapper: TestWrapper },
    );

    fillBaseFields();
    fireEvent.change(screen.getByLabelText(/parcela atual/i), { target: { value: '' } });

    const form = screen.getByLabelText(/descri/i).closest('form');
    if (!form) throw new Error('expected form');
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
  });
});
