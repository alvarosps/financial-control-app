/**
 * LoanCard integration test.
 *
 * Renders the real card inside the real NextIntl + tRPC provider stack.
 * The card fires `loan.getPayoff` on mount (stubbed via msw) and renders a
 * per-month paid/pending badge plus an optimistic mark-as-paid button.
 *
 * Provider + msw harness copied from
 * components/credit-cards/detail/dialogs/__tests__/PayBillDialog.test.tsx.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import rawPtMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../test/msw-server';
import { LoanCard } from '../LoanCard';

const linkClicks = vi.hoisted(() => vi.fn());

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.ComponentProps<'a'> & { href: string }) => (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        linkClicks(href);
      }}
    >
      {children}
    </a>
  ),
}));

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

// The real `item` prop type, derived through the component's public props so the
// whole fixture is structurally checked against it — no cast, and it guards
// against future drift in the loan.list output shape.
type LoanItem = React.ComponentProps<typeof LoanCard>['item'];

const baseItem = (isCurrentMonthPaid: boolean): LoanItem => ({
  account: {
    id: 'loan-1',
    userId: 'user-1',
    name: 'C6 — Strada',
    type: 'loan',
    currency: 'BRL',
    currentBalance: '0.00',
    icon: null,
    color: null,
    isActive: true,
    sortOrder: 0,
    overdraftLimit: null,
    cdiPercentage: null,
    parentAccountId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    openingBalance: '0.00',
    openingBalanceAnchorAt: null,
    cashAnchorBasis: 'recorded',
    isDefaultWallet: false,
  },
  config: {
    id: 'cfg-1',
    accountId: 'loan-1',
    loanCategory: 'bank',
    loanType: 'veiculo',
    totalInstallments: 35,
    monthlyPayment: '1531.00',
    dueDay: 4,
    monthlyInterestRate: '0.00000000',
    annualInterestRate: null,
    annualCet: null,
    annualCetSource: null,
    annualCetObservedOn: null,
    payoffQuoteAmount: null,
    payoffQuoteOn: null,
    payoffQuoteValidUntil: null,
    payoffQuoteSource: null,
    economicResponsibility: 'unknown',
    insuranceAmount: null,
    insurancePaymentDay: null,
    payoffCalculationType: null,
    principalAmount: null,
    originalAmount: null,
    startDate: new Date('2024-08-04T00:00:00Z'),
    comment: null,
    paymentMethod: null,
    incomeSourceAccountId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  schedule: null,
  currentInstallment: 18,
  overdueCount: isCurrentMonthPaid ? 0 : 1,
  isCurrentMonthPaid,
  isPaidOff: false,
});

function stubPayoff() {
  server.use(
    http.get(`${TRPC_URL}/loan.getPayoff`, () =>
      HttpResponse.json({
        result: {
          data: superjson.serialize({
            remainingInstallments: 17,
            outstandingBalance: '26027.00',
            savings: '0.00',
            savingsPercent: 0,
          }),
        },
      }),
    ),
    http.post(`${TRPC_URL}/loan.getPayoff`, () =>
      HttpResponse.json({
        result: {
          data: superjson.serialize({
            remainingInstallments: 17,
            outstandingBalance: '26027.00',
            savings: '0.00',
            savingsPercent: 0,
          }),
        },
      }),
    ),
  );
}

/**
 * The mark-as-paid dialog reads the wallet list and the next payable installment.
 * Both are tRPC queries, so they arrive as GET requests (unlike the POST mutation).
 */
function stubDialogQueries() {
  server.use(
    http.get(`${TRPC_URL}/loan.getNextPayable`, () =>
      HttpResponse.json({
        result: {
          data: superjson.serialize({
            transactionId: 'tx-1',
            date: '2026-06-04',
            amount: '1531.00',
            installmentNumber: 18,
            totalInstallments: 35,
          }),
        },
      }),
    ),
  );
}

function stubWallets() {
  server.use(
    http.get(`${TRPC_URL}/account.list`, () =>
      HttpResponse.json({
        result: {
          data: superjson.serialize([
            { id: 'wallet-1', name: 'Conta Corrente', type: 'checking', isActive: true },
          ]),
        },
      }),
    ),
  );
}

describe('LoanCard', () => {
  it('shows "pending this month" + mark-as-paid button when unpaid', async () => {
    stubPayoff();
    stubWallets();
    render(<LoanCard item={baseItem(false)} />, { wrapper: TestWrapper });
    expect(await screen.findByText(/pendente este mês/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /marcar como pago/i })).toBeInTheDocument();
  });

  it('shows "paid this month" and no button when paid', async () => {
    stubPayoff();
    stubWallets();
    render(<LoanCard item={baseItem(true)} />, { wrapper: TestWrapper });
    expect(await screen.findByText(/pago este mês/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /marcar como pago/i })).not.toBeInTheDocument();
  });

  it('shows the paid-off badge from the loan list contract', async () => {
    stubPayoff();
    stubWallets();
    render(<LoanCard item={{ ...baseItem(true), currentInstallment: 35, isPaidOff: true }} />, {
      wrapper: TestWrapper,
    });
    expect(await screen.findByText(/^quitado$/i)).toBeInTheDocument();
    expect(screen.queryByText(/pago este mês/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /marcar como pago/i })).not.toBeInTheDocument();
  });

  it('opens the wallet dialog (showing the target installment) without firing the mutation', async () => {
    stubPayoff();
    stubWallets();
    stubDialogQueries();
    const calls: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/loan.markCurrentAsPaid`, async ({ request }) => {
        calls.push(await request.json());
        return HttpResponse.json({
          result: { data: superjson.serialize({ remaining: 16 }) },
        });
      }),
    );
    render(<LoanCard item={baseItem(false)} />, { wrapper: TestWrapper });

    // Clicking the card button opens the dialog — it must NOT fire the mutation.
    fireEvent.click(await screen.findByRole('button', { name: /marcar como pago/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    // The dialog shows the next-payable target installment (from loan.getNextPayable).
    expect(await screen.findByText(/parcela 18\/35/i)).toBeInTheDocument();

    // Confirm is disabled until a wallet is chosen, so no payment is sent yet.
    expect(screen.getByRole('button', { name: /^confirmar$/i })).toBeDisabled();
    expect(calls.length).toBe(0);
  });

  it('confirms the payment without navigating to the loan detail page', async () => {
    linkClicks.mockClear();
    window.history.replaceState(null, '', '/loans');
    stubPayoff();
    stubDialogQueries();
    const calls: unknown[] = [];
    let walletLoaded = false;
    server.use(
      http.get(`${TRPC_URL}/account.list`, () => {
        walletLoaded = true;
        return HttpResponse.json({
          result: {
            data: superjson.serialize([
              { id: 'wallet-1', name: 'Conta Corrente', type: 'checking', isActive: true },
            ]),
          },
        });
      }),
      http.post(`${TRPC_URL}/loan.markCurrentAsPaid`, async ({ request }) => {
        calls.push(await request.json());
        return HttpResponse.json({
          result: { data: superjson.serialize({ remaining: 16 }) },
        });
      }),
    );
    render(<LoanCard item={baseItem(false)} />, { wrapper: TestWrapper });

    await screen.findByText(/pendente este mês/i);
    await waitFor(() => expect(walletLoaded).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /marcar como pago/i }));
    const confirm = await screen.findByRole('button', { name: /^confirmar$/i });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      json: { accountId: 'loan-1', paidFromAccountId: 'wallet-1' },
    });
    expect(linkClicks).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/loans');
  });
});
