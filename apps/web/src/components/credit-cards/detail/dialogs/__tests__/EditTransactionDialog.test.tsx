import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ptMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../../../test/msw-server';
import { EditTransactionDialog } from '../EditTransactionDialog';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

const TRPC_URL = 'http://localhost:3000/api/trpc';

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

const EXPENSE = {
  id: 'tx-1',
  description: 'Mercado',
  amount: '100.00',
  categoryId: null,
  date: new Date('2026-06-05'),
  domainType: 'credit_card_expense',
  isPaid: false,
};
const PAID_EXPENSE = { ...EXPENSE, id: 'tx-2', isPaid: true };
const REFUND = {
  id: 'tx-3',
  description: 'Estorno',
  amount: '40.00',
  categoryId: null,
  date: new Date('2026-06-05'),
  domainType: 'credit_card_refund',
  isPaid: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EditTransactionDialog', () => {
  it('seeds an expense and submits transaction.update', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post(`${TRPC_URL}/transaction.update`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'tx-1' }) } });
      }),
    );

    render(
      <EditTransactionDialog
        open={true}
        onOpenChange={() => {}}
        transaction={EXPENSE}
        categories={[]}
      />,
      { wrapper: TestWrapper },
    );

    await waitFor(() => {
      expect((screen.getByLabelText(/descrição/i) as HTMLInputElement).value).toBe('Mercado');
    });
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '150.00' } });
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect(calls[0].json).toMatchObject({ id: 'tx-1', description: 'Mercado', amount: '150.00' });
  });

  it('disables the amount field for a paid expense', async () => {
    render(
      <EditTransactionDialog
        open={true}
        onOpenChange={() => {}}
        transaction={PAID_EXPENSE}
        categories={[]}
      />,
      { wrapper: TestWrapper },
    );
    await waitFor(() => {
      expect((screen.getByLabelText(/descrição/i) as HTMLInputElement).value).toBe('Mercado');
    });
    expect((screen.getByLabelText(/valor/i) as HTMLInputElement).disabled).toBe(true);
  });

  it('refund variant has no category/date fields and submits only description+amount', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post(`${TRPC_URL}/transaction.update`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'tx-3' }) } });
      }),
    );

    render(
      <EditTransactionDialog
        open={true}
        onOpenChange={() => {}}
        transaction={REFUND}
        categories={[]}
      />,
      { wrapper: TestWrapper },
    );

    await waitFor(() => {
      expect((screen.getByLabelText(/descrição/i) as HTMLInputElement).value).toBe('Estorno');
    });
    expect(screen.queryByLabelText(/categoria/i)).toBeNull();
    expect(screen.queryByLabelText(/data/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));
    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect(calls[0].json).toMatchObject({ id: 'tx-3', description: 'Estorno', amount: '40.00' });
    expect(calls[0].json && 'categoryId' in calls[0].json).toBe(false);
    expect(calls[0].json && 'date' in calls[0].json).toBe(false);
  });
});
