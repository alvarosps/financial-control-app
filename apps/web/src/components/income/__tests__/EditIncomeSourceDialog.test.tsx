/**
 * EditIncomeSourceDialog integration test.
 *
 * Verifies the form pre-fills from the `source` prop, then the money-guard
 * path: an invalid amount (non-positive) fires a toast AND does NOT trigger
 * the `income.update` mutation. A valid amount triggers the mutation with
 * `accountId` plus the changed `amount` shaped as the canonical money string
 * produced by `toMoneyInputString`.
 *
 * Uses msw to capture tRPC HTTP requests. No `account.list` query is needed
 * (the edit dialog has no destination-account field). Selects are driven via
 * `@testing-library/user-event` (Base UI needs the full pointer sequence).
 */
import type { AppRouter } from '@fc/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { httpLink } from '@trpc/client';
import type { inferRouterOutputs } from '@trpc/server';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import rawPtMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../test/msw-server';
import { EditIncomeSourceDialog } from '../EditIncomeSourceDialog';

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

const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';

const USER_ID = '11111111-1111-1111-1111-111111111111';

// The real `source` prop type: one item of the income.list tRPC output. Building
// a complete, fully-typed object (account = accounts row, config/schedule = their
// rows or null) makes the compiler verify every field — no cast.
type IncomeSource = inferRouterOutputs<AppRouter>['income']['list'][number];

const SEED_SOURCE: IncomeSource = {
  account: {
    id: ACCOUNT_ID,
    userId: USER_ID,
    name: 'Salário CLT',
    type: 'revenue',
    currency: 'BRL',
    currentBalance: '0',
    icon: null,
    color: null,
    isActive: true,
    sortOrder: 0,
    overdraftLimit: null,
    cdiPercentage: null,
    parentAccountId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    openingBalance: '0',
    openingBalanceAnchorAt: null,
    cashAnchorBasis: 'recorded',
    isDefaultWallet: false,
  },
  config: {
    id: '33333333-3333-3333-3333-333333333333',
    accountId: ACCOUNT_ID,
    frequency: 'monthly',
    category: 'salary_clt',
    paymentDay: 5,
    exchangeRate: null,
    conversionFeePercent: '0',
    autoCreditByDate: false,
    biweeklyAnchor: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  schedule: {
    id: '44444444-4444-4444-4444-444444444444',
    userId: USER_ID,
    sourceAccountId: ACCOUNT_ID,
    destinationAccountId: '55555555-5555-5555-5555-555555555555',
    amount: '8000.00',
    amountChanges: [],
    purchaseDate: null,
    purchaseDateSource: 'unknown',
    currency: 'BRL',
    description: 'Salário CLT',
    categoryId: null,
    frequency: 'monthly',
    startDate: new Date('2026-03-05T12:00:00.000Z'),
    endDate: null,
    dueDay: null,
    totalOccurrences: null,
    startingOccurrence: 1,
    firstBillingMonth: null,
    firstBillingYear: null,
    isActive: true,
    notes: null,
    domainType: 'income_clt',
    domainConfigId: '33333333-3333-3333-3333-333333333333',
    isFixedCharge: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
};

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

describe('EditIncomeSourceDialog', () => {
  it('pre-fills the form from the source prop', () => {
    render(<EditIncomeSourceDialog open={true} onOpenChange={() => {}} source={SEED_SOURCE} />, {
      wrapper: TestWrapper,
    });

    const nameInput = screen.getByLabelText(/nome da fonte/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Salário CLT');

    const amountInput = screen.getByLabelText(/valor/i) as HTMLInputElement;
    expect(amountInput.value).toBe('8000.00');

    const paymentDayInput = screen.getByLabelText(/dia de pagamento/i) as HTMLInputElement;
    expect(paymentDayInput.value).toBe('5');
  });

  it('blocks submit with invalid money input — toast fires, no mutation sent', async () => {
    const updateCalls: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/income.update`, async ({ request }) => {
        updateCalls.push(await request.json());
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    render(<EditIncomeSourceDialog open={true} onOpenChange={() => {}} source={SEED_SOURCE} />, {
      wrapper: TestWrapper,
    });

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
    expect(updateCalls).toHaveLength(0);
  });

  it('sends mutation with accountId and the canonical money string', async () => {
    const updateCalls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post(`${TRPC_URL}/income.update`, async ({ request }) => {
        updateCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    const user = userEvent.setup();
    render(<EditIncomeSourceDialog open={true} onOpenChange={() => {}} source={SEED_SOURCE} />, {
      wrapper: TestWrapper,
    });

    const amountInput = screen.getByLabelText(/valor/i) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '9500' } });

    // Change frequency via the Select to exercise the user-event path.
    await user.click(screen.getByLabelText(/frequência/i));
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Único' })).toBeTruthy();
    });
    await user.click(screen.getByRole('option', { name: 'Único' }));

    const form = amountInput.closest('form');
    if (!form) throw new Error('expected form');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(updateCalls.length).toBe(1);
    });

    expect(updateCalls[0].json).toMatchObject({
      accountId: ACCOUNT_ID,
      amount: '9500.00',
      frequency: 'one_time',
    });
  });

  it('blocks closing while pending and invalidates income data on success', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    server.use(
      http.post(`${TRPC_URL}/income.update`, async () => {
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
    render(
      <>
        <EditIncomeSourceDialog open onOpenChange={onOpenChange} source={SEED_SOURCE} />
        <IncomeListProbe />
      </>,
      { wrapper: TestWrapper },
    );
    fireEvent.submit(screen.getByLabelText(/nome da fonte/i).closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('button', { name: /salvando/i })).toBeDisabled());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    release?.();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('shows update failures', async () => {
    server.use(
      http.post(`${TRPC_URL}/income.update`, () =>
        HttpResponse.json(
          {
            error: {
              json: {
                message: 'Atualização indisponível',
                code: -32603,
                data: { httpStatus: 500 },
              },
            },
          },
          { status: 500 },
        ),
      ),
    );
    render(<EditIncomeSourceDialog open onOpenChange={() => {}} source={SEED_SOURCE} />, {
      wrapper: TestWrapper,
    });
    fireEvent.submit(screen.getByLabelText(/nome da fonte/i).closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Atualização indisponível'),
    );
  });
});
