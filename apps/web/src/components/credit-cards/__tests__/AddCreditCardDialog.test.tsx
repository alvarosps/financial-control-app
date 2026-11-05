import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import rawPtMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../test/msw-server';
import { AddCreditCardDialog } from '../AddCreditCardDialog';

const TRPC_URL = 'http://localhost:3000/api/trpc';

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const trpcClient = trpc.createClient({
    links: [httpLink({ url: TRPC_URL, transformer: superjson })],
  });
  return (
    <NextIntlClientProvider locale="pt-BR" messages={rawPtMessages} onError={() => {}}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </NextIntlClientProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

function CreditCardProbe() {
  trpc.creditCard.listConfigs.useQuery();
  return null;
}

describe('AddCreditCardDialog', () => {
  it('sends the canonical two-step payload and resets when it closes after success', async () => {
    const onOpenChange = vi.fn();
    const accountCalls: Array<{ json?: Record<string, unknown> }> = [];
    const configCalls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post(`${TRPC_URL}/account.create`, async ({ request }) => {
        accountCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({
          result: { data: superjson.serialize({ id: 'card-account-id' }) },
        });
      }),
      http.post(`${TRPC_URL}/creditCard.upsertConfig`, async ({ request }) => {
        configCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
      http.post(`${TRPC_URL}/scheduled.list`, () =>
        HttpResponse.json({ result: { data: superjson.serialize([]) } }),
      ),
      http.post(`${TRPC_URL}/creditCard/:procedure`, () =>
        HttpResponse.json({ result: { data: superjson.serialize([]) } }),
      ),
      http.post(`${TRPC_URL}/account/:procedure`, () =>
        HttpResponse.json({ result: { data: superjson.serialize([]) } }),
      ),
      http.post(`${TRPC_URL}/dashboard/:procedure`, () =>
        HttpResponse.json({ result: { data: superjson.serialize([]) } }),
      ),
    );

    const { rerender } = render(<AddCreditCardDialog open onOpenChange={onOpenChange} />, {
      wrapper: TestWrapper,
    });
    fireEvent.change(screen.getByLabelText(/nome do cartão/i), { target: { value: 'Nubank' } });
    fireEvent.change(screen.getByLabelText(/dia de fechamento/i), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/dia de vencimento/i), { target: { value: '17' } });
    fireEvent.change(screen.getByLabelText(/limite/i), { target: { value: '2500' } });
    const form = screen.getByLabelText(/limite/i).closest('form');
    if (!form) throw new Error('expected credit-card form');
    fireEvent.submit(form);

    await waitFor(() => expect(configCalls).toHaveLength(1));
    expect(accountCalls[0].json).toMatchObject({
      name: 'Nubank',
      type: 'credit_card',
      currency: 'BRL',
    });
    expect(configCalls[0].json).toMatchObject({
      accountId: 'card-account-id',
      closingDay: 10,
      dueDay: 17,
      creditLimit: '2500.00',
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    rerender(<AddCreditCardDialog open onOpenChange={onOpenChange} />);
    expect(screen.getByLabelText(/nome do cartão/i)).toHaveValue('');
  });

  it('blocks every close path while either creation step is pending and invalidates card context', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let configReads = 0;
    server.use(
      http.post(`${TRPC_URL}/account.create`, () =>
        HttpResponse.json({ result: { data: superjson.serialize({ id: 'card-account-id' }) } }),
      ),
      http.post(`${TRPC_URL}/creditCard.upsertConfig`, async () => {
        await pending;
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
      http.post(`${TRPC_URL}/creditCard.listConfigs`, () => {
        configReads += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
      http.get(`${TRPC_URL}/creditCard.listConfigs`, () => {
        configReads += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
    );
    const onOpenChange = vi.fn();
    render(
      <>
        <AddCreditCardDialog open onOpenChange={onOpenChange} />
        <CreditCardProbe />
      </>,
      { wrapper: TestWrapper },
    );
    fireEvent.change(screen.getByLabelText(/nome do cart/i), { target: { value: 'Nubank' } });
    fireEvent.change(screen.getByLabelText(/dia de fechamento/i), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/dia de vencimento/i), { target: { value: '17' } });
    fireEvent.submit(screen.getByLabelText(/nome do cart/i).closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('button', { name: /salvando/i })).toBeDisabled());
    expect(screen.getByRole('button', { name: /cancelar/i })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    release?.();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(configReads).toBeGreaterThanOrEqual(2));
  });

  it('reports a failed configuration step and keeps the dialog open', async () => {
    const onOpenChange = vi.fn();
    const error = vi.spyOn(toast, 'error');
    server.use(
      http.post(`${TRPC_URL}/account.create`, () =>
        HttpResponse.json({ result: { data: superjson.serialize({ id: 'card-account-id' }) } }),
      ),
      http.post(`${TRPC_URL}/creditCard.upsertConfig`, () =>
        HttpResponse.json(
          {
            error: {
              json: { message: 'Configuração falhou', code: -32603, data: { httpStatus: 500 } },
            },
          },
          { status: 500 },
        ),
      ),
    );
    render(<AddCreditCardDialog open onOpenChange={onOpenChange} />, { wrapper: TestWrapper });
    fireEvent.change(screen.getByLabelText(/nome do cart/i), { target: { value: 'Nubank' } });
    fireEvent.change(screen.getByLabelText(/dia de fechamento/i), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/dia de vencimento/i), { target: { value: '17' } });
    fireEvent.submit(screen.getByLabelText(/nome do cart/i).closest('form') as HTMLFormElement);
    await waitFor(() => expect(error).toHaveBeenCalledWith('Configuração falhou'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
