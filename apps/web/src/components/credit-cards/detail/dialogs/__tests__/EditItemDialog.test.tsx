/**
 * EditItemDialog integration test.
 *
 * Verifies the money-guard path: invalid amount (non-numeric) shows a toast
 * AND does NOT trigger the `scheduled.update` mutation. Valid amount does
 * trigger the mutation with `amount` shaped as the canonical money string
 * produced by `toMoneyInputString`.
 *
 * Uses msw to capture tRPC HTTP requests; `scheduled.getById` is mocked to
 * return a pre-seeded schedule so the dialog has something to populate.
 */
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
import { server } from '../../../../../test/msw-server';
import { EditItemDialog } from '../EditItemDialog';

// Mock sonner (third-party boundary). The vi.mock factory return is NOT
// type-checked against the real module, so a partial { error, success }
// object needs no cast; assertions read the spies via vi.mocked(toast.error).
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

// A fixed charge edits through `scheduled.update` (no re-materialization), which
// is the money-guard path these first two tests exercise.
const SEED_ITEM = {
  id: 'item-1',
  description: 'Netflix',
  amount: '500.00',
  categoryId: null,
  notes: null,
  domainType: 'credit_card_fixed_charge',
  startingOccurrence: null,
  totalOccurrences: null,
};

// An installment edits through `creditCard.editInstallment` (recomputes the
// whole series). The schedule always stores starting_occurrence=1 + the first
// parcela amount; the dialog is fed the CURRENT row's parcela + amount via props.
const SEED_INSTALLMENT = {
  id: 'item-1',
  description: 'MERCADOL',
  amount: '30.98',
  categoryId: null,
  notes: null,
  domainType: 'credit_card_installment',
  startingOccurrence: 1,
  totalOccurrences: 3,
};

function seedGetByIdHandler(item: Record<string, unknown> = SEED_ITEM) {
  server.use(
    http.post(`${TRPC_URL}/scheduled.getById`, () => {
      const payload = superjson.serialize(item);
      return HttpResponse.json({ result: { data: payload } });
    }),
    http.get(`${TRPC_URL}/scheduled.getById`, () => {
      const payload = superjson.serialize(item);
      return HttpResponse.json({ result: { data: payload } });
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EditItemDialog', () => {
  it('blocks submit with invalid money input — toast fires, no mutation sent', async () => {
    seedGetByIdHandler();
    const updateCalls: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/scheduled.update`, async ({ request }) => {
        updateCalls.push(await request.json());
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    render(
      <EditItemDialog
        open={true}
        onOpenChange={() => {}}
        itemId="item-1"
        categories={[]}
        billMonth={6}
        billYear={2026}
      />,
      { wrapper: TestWrapper },
    );

    // Wait for the populated description (proves getById resolved)
    await waitFor(() => {
      expect((screen.getByLabelText(/valor/i) as HTMLInputElement).value).toBe('500');
    });

    // Corrupt the amount to something that won't parse as money.
    // A negative number bypasses jsdom's number-input coercion while still
    // tripping `toMoneyInputString` (which rejects n <= 0).
    const amountInput = screen.getByLabelText(/valor/i) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '-5' } });

    // Submit the form directly; clicking `type="submit"` in jsdom sometimes
    // does not bubble up to the form's submit handler.
    const form = amountInput.closest('form');
    if (!form) throw new Error('expected form');
    fireEvent.submit(form);

    // toast.error must fire; mutation must NOT.
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });
    // Give the event loop a tick so any in-flight mutation would have been POSTed.
    await new Promise((r) => setTimeout(r, 50));
    expect(updateCalls).toHaveLength(0);
  });

  it('sends mutation with canonical money string when amount is valid', async () => {
    seedGetByIdHandler();
    const updateCalls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post(`${TRPC_URL}/scheduled.update`, async ({ request }) => {
        updateCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    render(
      <EditItemDialog
        open={true}
        onOpenChange={() => {}}
        itemId="item-1"
        categories={[]}
        billMonth={6}
        billYear={2026}
      />,
      { wrapper: TestWrapper },
    );

    await waitFor(() => {
      expect((screen.getByLabelText(/valor/i) as HTMLInputElement).value).toBe('500');
    });

    const amountInput = screen.getByLabelText(/valor/i) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '12.34' } });

    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => {
      expect(updateCalls.length).toBe(1);
    });

    expect(updateCalls[0].json).toMatchObject({ id: 'item-1', amount: '12.34' });
  });

  it('installment edit sends creditCard.editInstallment with the CURRENT parcela + bill period', async () => {
    seedGetByIdHandler(SEED_INSTALLMENT);
    const editCalls: Array<{ json?: Record<string, unknown> }> = [];
    const updateCalls: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/creditCard.editInstallment`, async ({ request }) => {
        editCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
      http.post(`${TRPC_URL}/scheduled.update`, async ({ request }) => {
        updateCalls.push(await request.json());
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );

    render(
      <EditItemDialog
        open={true}
        onOpenChange={() => {}}
        itemId="item-1"
        categories={[]}
        currentInstallment={3}
        currentAmount="30.99"
        billMonth={6}
        billYear={2026}
      />,
      { wrapper: TestWrapper },
    );

    // Dialog must pre-fill the CURRENT row's value (30.99) and parcela (3),
    // NOT the schedule's first-parcela amount (30.98) / starting_occurrence (1).
    await waitFor(() => {
      expect((screen.getByLabelText(/valor/i) as HTMLInputElement).value).toBe('30.99');
    });
    expect((screen.getByLabelText(/parcela atual/i) as HTMLInputElement).value).toBe('3');

    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => {
      expect(editCalls.length).toBe(1);
    });
    // Installments never go through scheduled.update.
    expect(updateCalls).toHaveLength(0);
    expect(editCalls[0].json).toMatchObject({
      scheduleId: 'item-1',
      amount: '30.99',
      totalInstallments: 3,
      currentInstallmentNumber: 3,
      currentBillingMonth: 6,
      currentBillingYear: 2026,
    });
  });
});
