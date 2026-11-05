/**
 * AddIncomeSourceDialog integration test.
 *
 * Verifies the money-guard path: an invalid amount (non-positive) fires a
 * toast AND does NOT trigger the `income.create` mutation. A valid amount
 * triggers the mutation with `amount` shaped as the canonical money string
 * produced by `toMoneyInputString`, and `frequency: 'one_time'` when the
 * one-time option is selected.
 *
 * Uses msw to capture tRPC HTTP requests; `account.list` is mocked so the
 * destination-account Select has an option to pick.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import rawPtMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../test/msw-server';
import { AddIncomeSourceDialog } from '../AddIncomeSourceDialog';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

// Rehydrate i18n messages so `t('ns.hash')` resolves.
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

const SEED_ACCOUNTS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Conta Corrente',
    type: 'checking',
    currency: 'BRL',
    isActive: true,
  },
];

function seedAccountListHandler() {
  server.use(
    http.post(`${TRPC_URL}/account.list`, () =>
      HttpResponse.json({ result: { data: superjson.serialize(SEED_ACCOUNTS) } }),
    ),
    http.get(`${TRPC_URL}/account.list`, () =>
      HttpResponse.json({ result: { data: superjson.serialize(SEED_ACCOUNTS) } }),
    ),
  );
}

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

function IncomeListProbe() {
  trpc.income.list.useQuery();
  return null;
}

describe('AddIncomeSourceDialog', () => {
  it('blocks submit with invalid money input — toast fires, no mutation sent', async () => {
    seedAccountListHandler();
    const createCalls: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/income.create`, async ({ request }) => {
        createCalls.push(await request.json());
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    render(<AddIncomeSourceDialog open={true} onOpenChange={() => {}} />, { wrapper: TestWrapper });

    // Fill the required name so the blocker is the amount guard, not fillRequired.
    const nameInput = screen.getByLabelText(/nome da fonte/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Salário' } });

    const amountInput = screen.getByLabelText(/valor/i) as HTMLInputElement;
    // Negative bypasses jsdom number coercion but trips toMoneyInputString (n <= 0).
    fireEvent.change(amountInput, { target: { value: '-5' } });

    const form = amountInput.closest('form');
    if (!form) throw new Error('expected form');
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(createCalls).toHaveLength(0);
  });

  it('sends mutation with canonical money string and frequency one_time', async () => {
    seedAccountListHandler();
    const createCalls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post(`${TRPC_URL}/income.create`, async ({ request }) => {
        createCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    const user = userEvent.setup();
    render(<AddIncomeSourceDialog open={true} onOpenChange={() => {}} />, { wrapper: TestWrapper });

    const nameInput = screen.getByLabelText(/nome da fonte/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Bônus' } });

    const amountInput = screen.getByLabelText(/valor/i) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '1500' } });

    // Open the destination Select (options mount on open) and pick the account
    // loaded via the mocked `account.list` query. user-event dispatches the
    // full pointer sequence Base UI needs to commit onValueChange.
    await user.click(screen.getByLabelText(/conta de destino/i));
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Conta Corrente' })).toBeTruthy();
    });
    await user.click(screen.getByRole('option', { name: 'Conta Corrente' }));

    // Open the frequency Select and pick the one-time option.
    await user.click(screen.getByLabelText(/frequência/i));
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Único' })).toBeTruthy();
    });
    await user.click(screen.getByRole('option', { name: 'Único' }));

    const form = amountInput.closest('form');
    if (!form) throw new Error('expected form');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(createCalls.length).toBe(1);
    });

    expect(createCalls[0].json).toMatchObject({
      amount: '1500.00',
      frequency: 'one_time',
      destinationAccountId: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('guards pending close, invalidates income data after success, and reports errors', async () => {
    seedAccountListHandler();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    server.use(
      http.post(`${TRPC_URL}/income.create`, async () => {
        await pending;
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
      http.post(`${TRPC_URL}/income.list`, () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
      http.get(`${TRPC_URL}/income.list`, () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
    );
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <AddIncomeSourceDialog open onOpenChange={onOpenChange} />
        <IncomeListProbe />
      </>,
      { wrapper: TestWrapper },
    );
    fireEvent.change(screen.getByLabelText(/nome da fonte/i), { target: { value: 'Salário' } });
    fireEvent.change(screen.getByLabelText(/^valor/i), { target: { value: '100' } });
    await user.click(screen.getByLabelText(/conta de destino/i));
    await user.click(await screen.findByRole('option', { name: 'Conta Corrente' }));
    fireEvent.submit(screen.getByLabelText(/^valor/i).closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('button', { name: /salvando/i })).toBeDisabled());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    release?.();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('shows an API error without closing', async () => {
    seedAccountListHandler();
    server.use(
      http.post(`${TRPC_URL}/income.create`, () =>
        HttpResponse.json(
          {
            error: {
              json: { message: 'Renda indisponível', code: -32603, data: { httpStatus: 500 } },
            },
          },
          { status: 500 },
        ),
      ),
    );
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AddIncomeSourceDialog open onOpenChange={onOpenChange} />, { wrapper: TestWrapper });
    fireEvent.change(screen.getByLabelText(/nome da fonte/i), { target: { value: 'Salário' } });
    fireEvent.change(screen.getByLabelText(/^valor/i), { target: { value: '100' } });
    await user.click(screen.getByLabelText(/conta de destino/i));
    await user.click(await screen.findByRole('option', { name: 'Conta Corrente' }));
    fireEvent.submit(screen.getByLabelText(/^valor/i).closest('form') as HTMLFormElement);
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Renda indisponível'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
