import { AccountType, validateTransactionAccounts } from '@fc/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ptMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../test/msw-server';
import { QuickAddSheet } from '../QuickAddSheet';

const toastState = vi.hoisted(() => ({
  error: vi.fn(),
  undo: undefined as (() => void) | undefined,
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastState.error,
    success: vi.fn((_message: unknown, options: unknown) => {
      if (typeof options !== 'object' || options === null || !('action' in options)) return;
      const { action } = options;
      if (typeof action !== 'object' || action === null || !('onClick' in action)) return;
      const { onClick } = action;
      if (typeof onClick !== 'function') return;
      toastState.undo = () => onClick();
    }),
  },
  Toaster: () => null,
}));

const trpcUrl = 'http://localhost:3000/api/trpc';
const baseProps = {
  open: true,
  onOpenChange: () => {},
  wallets: [{ id: 'w1', name: 'Conta principal', isDefaultWallet: true }],
  cards: [{ id: 'c1', name: 'Cartão principal' }],
  cardConfigs: [{ accountId: 'c1', closingDay: 28 }],
  categories: [{ id: 'cat1', name: 'Alimentação' }],
  expenseAccountId: 'exp-general',
  cardExpenseAccountId: 'exp-card',
};

function renderSheet() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const trpcClient = trpc.createClient({
    links: [httpLink({ url: trpcUrl, transformer: superjson })],
  });
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

  render(
    <NextIntlClientProvider locale="pt-BR" messages={ptMessages as Record<string, unknown>}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <QuickAddSheet {...baseProps} />
        </QueryClientProvider>
      </trpc.Provider>
    </NextIntlClientProvider>,
  );

  return { invalidateQueries };
}

function fillAndSubmit(amount: string, description: string) {
  fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: amount } });
  fireEvent.change(screen.getByLabelText(/descrição/i), { target: { value: description } });
  fireEvent.click(screen.getByRole('button', { name: /adicionar/i }));
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  toastState.undo = undefined;
});

describe('QuickAddSheet', () => {
  it('submits a domain-valid expense-to-wallet entry, invalidates caches, persists, and undoes', async () => {
    const createCalls: Array<{ json?: Record<string, unknown> }> = [];
    const undoCalls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post(`${trpcUrl}/transaction.create`, async ({ request }) => {
        createCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'tx-1' }) } });
      }),
      http.post(`${trpcUrl}/transaction.reverse`, async ({ request }) => {
        undoCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    const { invalidateQueries } = renderSheet();

    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByLabelText(/pagar com/i)).toHaveTextContent('wallet:w1'));
    fillAndSubmit('25,90', 'Padaria');

    await waitFor(() => expect(createCalls).toHaveLength(1));
    // TransactionService delegates this exact source/destination constraint to
    // the real domain rule: an expense cannot be the destination account.
    expect(validateTransactionAccounts(AccountType.EXPENSE, AccountType.CHECKING)).toEqual({
      valid: true,
    });
    expect(validateTransactionAccounts(AccountType.CHECKING, AccountType.EXPENSE)).toEqual({
      valid: false,
      reason: 'Expense accounts can only be transaction sources',
    });
    expect(createCalls[0].json).toMatchObject({
      sourceAccountId: 'exp-general',
      destinationAccountId: 'w1',
      amount: '25.90',
      description: 'Padaria',
    });
    expect(localStorage.getItem('fc.quickAdd.lastDestination')).toBe(
      JSON.stringify({ kind: 'wallet', walletId: 'w1' }),
    );
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledTimes(7));

    expect(toastState.undo).toBeDefined();
    toastState.undo?.();
    await waitFor(() => expect(undoCalls).toHaveLength(1));
    expect(undoCalls[0].json).toMatchObject({ id: 'tx-1' });
  });

  it('uses a persisted card, invalidates its card context, and reverses its transaction on undo', async () => {
    localStorage.setItem(
      'fc.quickAdd.lastDestination',
      JSON.stringify({ kind: 'card', cardId: 'c1' }),
    );
    const createCalls: Array<{ json?: Record<string, unknown> }> = [];
    const undoCalls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post(`${trpcUrl}/creditCard.addOneTimeExpense`, async ({ request }) => {
        createCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({
          result: {
            data: superjson.serialize({ transaction: { id: 'tx-card-1' }, materialized: {} }),
          },
        });
      }),
      http.post(`${trpcUrl}/transaction.reverse`, async ({ request }) => {
        undoCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    const { invalidateQueries } = renderSheet();

    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByLabelText(/pagar com/i)).toHaveTextContent('card:c1'));
    expect((screen.getByLabelText('Data da compra') as HTMLInputElement).value).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    fireEvent.change(screen.getByLabelText('Data da compra'), { target: { value: '2026-09-20' } });
    fillAndSubmit('99,00', 'Farmácia');

    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0].json).toMatchObject({
      creditCardAccountId: 'c1',
      expenseAccountId: 'exp-card',
      amount: '99.00',
      description: 'Farmácia',
      purchaseDate: '2026-09-20',
    });
    await waitFor(() => expect(invalidateQueries.mock.calls.length).toBeGreaterThanOrEqual(20));

    expect(toastState.undo).toBeDefined();
    toastState.undo?.();
    await waitFor(() => expect(undoCalls).toHaveLength(1));
    expect(undoCalls[0].json).toMatchObject({ id: 'tx-card-1' });
  });

  it('rejects an invalid amount without calling a mutation', async () => {
    const calls: unknown[] = [];
    server.use(
      http.post(`${trpcUrl}/transaction.create`, () => {
        calls.push({});
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'unexpected' }) } });
      }),
    );
    renderSheet();

    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByLabelText(/pagar com/i)).toHaveTextContent('wallet:w1'));
    fillAndSubmit('invalid', 'Teste');

    expect(toastState.error).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
