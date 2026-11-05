import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rollbackPaidFor, setPaidFor } from '@/lib/optimistic-paid';
import { obligationFixture, stubFinancialWallets } from '@/test/financial-fixtures';
import { server } from '@/test/msw-server';
import { installHistorySync, resetFakeSearchParams } from '@/test/next-navigation-fake';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { ChargesClient } from './ChargesClient';

vi.mock('next/navigation', async () => {
  const fake = await import('@/test/next-navigation-fake');
  return { useSearchParams: fake.useFakeSearchParams };
});

const chargeRow = (isPaid: boolean) => ({
  id: 'sched-1',
  description: 'Aluguel',
  frequency: 'monthly',
  dueDay: 5,
  amount: '1200.00',
  transactionId: 'tx-1',
  isPaid,
});

function stubQueries(isPaid: boolean) {
  server.use(
    http.get(`${TRPC_TEST_URL}/transaction.obligations`, () =>
      HttpResponse.json({
        result: {
          data: superjson.serialize({
            items: [
              {
                ...obligationFixture,
                ref: { kind: 'charge', transactionId: 'tx-1' },
                name: 'Aluguel',
                canUndo: true,
              },
            ],
            reviewIssues: [],
            summary: {},
          }),
        },
      }),
    ),
    http.get(`${TRPC_TEST_URL}/charges.list`, () =>
      HttpResponse.json({
        result: { data: superjson.serialize({ fixed: [chargeRow(isPaid)], oneTime: [] }) },
      }),
    ),
    http.get(`${TRPC_TEST_URL}/account.list`, () =>
      HttpResponse.json({
        result: {
          data: superjson.serialize([
            {
              id: 'wallet-1',
              name: 'Conta Corrente',
              type: 'checking',
              isActive: true,
              isDefaultWallet: true,
            },
          ]),
        },
      }),
    ),
  );
}

describe('ChargesClient confirmed settlement state', () => {
  let restoreHistory: () => void;

  beforeEach(() => {
    window.history.replaceState(null, '', '/charges');
    resetFakeSearchParams();
    restoreHistory = installHistorySync();
  });
  afterEach(() => restoreHistory());

  it('keeps the paid badge until undo is confirmed', async () => {
    stubQueries(true);
    let releaseUndo: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUndo = resolve;
    });
    server.use(
      http.post(`${TRPC_TEST_URL}/charges.markOccurrenceAsUnpaid`, async () => {
        await gate;
        return HttpResponse.json({ result: { data: superjson.serialize({ ok: true }) } });
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <ChargesClient initialMonth={6} initialYear={2026} />
      </TRPCTestProvider>,
    );
    expect(await screen.findByText('Aluguel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
    expect(await screen.findByText('Pago')).toBeInTheDocument();
    expect(screen.queryByText('Pendente')).not.toBeInTheDocument();
    stubQueries(false);
    releaseUndo();
    await waitFor(() => expect(screen.getByText('Pendente')).toBeInTheDocument());
  });

  it('rolls an undo error back to paid', async () => {
    stubQueries(true);
    server.use(
      http.post(`${TRPC_TEST_URL}/charges.markOccurrenceAsUnpaid`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <ChargesClient initialMonth={6} initialYear={2026} />
      </TRPCTestProvider>,
    );
    expect(await screen.findByText('Pago')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
    await waitFor(() => expect(screen.getByText('Pago')).toBeInTheDocument());
  });

  it('rolls a mark-paid error back to pending', async () => {
    stubQueries(false);
    stubFinancialWallets();
    let releaseFailure: () => void = () => {};
    const failure = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    server.use(
      http.post(`${TRPC_TEST_URL}/charges.markOccurrenceAsPaid`, async () => {
        await failure;
        return HttpResponse.json({ error: 'boom' }, { status: 500 });
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <ChargesClient initialMonth={6} initialYear={2026} />
      </TRPCTestProvider>,
    );
    expect(await screen.findByText('Pendente')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Registrar pagamento' }));
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Conta Corrente' }));
    fireEvent.change(screen.getByLabelText(/Data e hora do pagamento/), {
      target: { value: '2026-06-12T09:00' },
    });
    const submit = screen.getAllByRole('button', { name: 'Registrar pagamento' }).at(-1);
    if (!submit) throw new Error('submit missing');
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    expect(await screen.findByText('Pendente')).toBeInTheDocument();
    releaseFailure();
    await waitFor(() => expect(screen.getByText('Pendente')).toBeInTheDocument());
  });

  it('does not overwrite a concurrent successful row while another update rolls back', () => {
    const starting = [
      chargeRow(true),
      { ...chargeRow(true), id: 'sched-2', transactionId: 'tx-2' },
    ];
    const afterA = setPaidFor(starting, (row) => row.transactionId === 'tx-1', false);
    const afterB = setPaidFor(afterA, (row) => row.transactionId === 'tx-2', false);
    const afterAFails = rollbackPaidFor(afterB, (row) => row.transactionId, 'tx-1', true, false);

    expect(afterAFails?.map((row) => row.isPaid)).toEqual([true, false]);
  });
});
