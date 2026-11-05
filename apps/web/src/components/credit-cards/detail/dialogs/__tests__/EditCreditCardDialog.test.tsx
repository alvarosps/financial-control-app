import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ptMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../../../test/msw-server';
import { EditCreditCardDialog } from '../EditCreditCardDialog';

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

const ACCOUNT = { id: 'card-1', name: 'C6', color: '#ff8800' };
const CONFIG = { closingDay: 3, dueDay: 10, creditLimit: '3420.00', isDueDayVariable: false };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EditCreditCardDialog', () => {
  it('seeds from props and submits account.update then creditCard.upsertConfig', async () => {
    const accountUpdateCalls: Array<{ json?: Record<string, unknown> }> = [];
    const upsertConfigCalls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post(`${TRPC_URL}/account.update`, async ({ request }) => {
        accountUpdateCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'card-1' }) } });
      }),
      http.post(`${TRPC_URL}/creditCard.upsertConfig`, async ({ request }) => {
        upsertConfigCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    render(
      <EditCreditCardDialog
        open={true}
        onOpenChange={() => {}}
        account={ACCOUNT}
        config={CONFIG}
      />,
      { wrapper: TestWrapper },
    );

    await waitFor(() => {
      expect((screen.getByLabelText(/nome do cartão/i) as HTMLInputElement).value).toBe('C6');
    });

    fireEvent.change(screen.getByLabelText(/nome do cartão/i), { target: { value: 'C6 Black' } });
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => {
      expect(accountUpdateCalls.length).toBe(1);
      expect(upsertConfigCalls.length).toBe(1);
    });

    expect(accountUpdateCalls[0].json).toMatchObject({
      id: 'card-1',
      name: 'C6 Black',
      color: '#ff8800',
    });
    expect(upsertConfigCalls[0].json).toMatchObject({
      accountId: 'card-1',
      closingDay: 3,
      dueDay: 10,
      creditLimit: '3420.00',
      isDueDayVariable: false,
    });
  });

  it('blocks submit when the limit is invalid — toast.error, no mutation', async () => {
    const accountUpdateCalls: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/account.update`, async ({ request }) => {
        accountUpdateCalls.push(await request.json());
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'card-1' }) } });
      }),
    );

    render(
      <EditCreditCardDialog
        open={true}
        onOpenChange={() => {}}
        account={ACCOUNT}
        config={CONFIG}
      />,
      { wrapper: TestWrapper },
    );

    await waitFor(() => {
      expect((screen.getByLabelText(/nome do cartão/i) as HTMLInputElement).value).toBe('C6');
    });

    const limit = screen.getByLabelText(/limite/i) as HTMLInputElement;
    fireEvent.change(limit, { target: { value: '-5' } });
    const form = limit.closest('form');
    if (!form) throw new Error('expected form');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(accountUpdateCalls).toHaveLength(0);
  });
});
