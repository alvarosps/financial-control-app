import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { QuickPayBillDialog } from '../QuickPayBillDialog';

const target = { cardId: 'card-1', cardName: 'Azul', month: 9, year: 2026, dueDate: '2026-10-05' };
const result = (data: unknown) =>
  HttpResponse.json({ result: { data: superjson.serialize(data) } });
const error = (message: string) =>
  HttpResponse.json(
    {
      error: {
        json: { message, code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 } },
      },
    },
    { status: 500 },
  );
const bill = {
  total: 800,
  unpaidTotal: 300,
  currency: 'BRL',
  isPaid: false,
  transactionCount: 2,
  breakdown: [],
};

function renderDialog(paymentAccounts = [{ id: 'wallet-1', name: 'Conta' }]) {
  const onClose = vi.fn();
  const ui = (card = target) => (
    <TRPCTestProvider>
      <QuickPayBillDialog
        key={card.cardId}
        target={card}
        paymentAccounts={paymentAccounts}
        accountsLoading={false}
        onRetryAccounts={async () => {}}
        onOpenChange={onClose}
      />
    </TRPCTestProvider>
  );
  const view = renderWithProviders(ui());
  return { onClose, ...view, ui };
}

describe('QuickPayBillDialog', () => {
  it('blocks confirmation until the latest bill loads and retries failed reads', async () => {
    let reads = 0;
    server.use(
      http.get(`${TRPC_TEST_URL}/creditCard.getConsolidatedBill`, async () => {
        reads++;
        await delay(30);
        return reads === 1 ? error('Falha ao ler fatura') : result(bill);
      }),
    );
    renderDialog();
    expect(screen.getByRole('status')).toHaveTextContent('Carregando');
    expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Falha ao ler fatura');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    fireEvent.change(await screen.findByLabelText(/Data e hora do pagamento/), {
      target: { value: '2026-09-12T09:00' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar' })).toBeEnabled());
    expect(reads).toBe(2);
  });

  it('keeps the selected account after a failed payment and revalidates the bill', async () => {
    const reads = vi.fn();
    server.use(
      http.get(`${TRPC_TEST_URL}/creditCard.getConsolidatedBill`, () => {
        reads();
        return result(bill);
      }),
      http.post(`${TRPC_TEST_URL}/creditCard.payBill`, () => error('Pagamento recusado')),
    );
    const { onClose } = renderDialog();
    fireEvent.change(await screen.findByLabelText(/Data e hora do pagamento/), {
      target: { value: '2026-09-12T09:00' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pagamento recusado');
    await waitFor(() => expect(reads.mock.calls.length).toBe(2));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByLabelText(/Data e hora do pagamento/), {
      target: { value: '2026-09-12T09:00' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar' })).toBeEnabled());
    expect(screen.getByText('Conta')).toBeInTheDocument();
  });

  it('hides confirmation when a stale list item has already been paid', async () => {
    server.use(
      http.get(`${TRPC_TEST_URL}/creditCard.getConsolidatedBill`, () =>
        result({ ...bill, isPaid: true, unpaidTotal: 0 }),
      ),
    );
    renderDialog();
    expect(await screen.findByText('Nada a pagar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
  });

  it('requires a choice among multiple accounts and blocks closing while paying', async () => {
    let finishPayment: (() => void) | undefined;
    const request = new Promise<void>((resolve) => {
      finishPayment = resolve;
    });
    const calls: unknown[] = [];
    server.use(
      http.get(`${TRPC_TEST_URL}/creditCard.getConsolidatedBill`, () => result(bill)),
      http.post(`${TRPC_TEST_URL}/creditCard.payBill`, async ({ request: incoming }) => {
        calls.push(await incoming.json());
        await request;
        return result({ billTotal: '300.00' });
      }),
    );
    const user = userEvent.setup();
    const { onClose } = renderDialog([
      { id: 'wallet-1', name: 'Conta' },
      { id: 'wallet-2', name: 'Poupança' },
    ]);
    expect(await screen.findByRole('button', { name: 'Confirmar' })).toBeDisabled();
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Poupança' }));
    fireEvent.change(await screen.findByLabelText(/Data e hora do pagamento/), {
      target: { value: '2026-09-12T09:00' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ json: { paidFromAccountId: 'wallet-2' } });
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    finishPayment?.();
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
  });

  it('discards another card amount and account selection when the target changes', async () => {
    server.use(
      http.get(`${TRPC_TEST_URL}/creditCard.getConsolidatedBill`, async ({ request }) => {
        const input = JSON.parse(new URL(request.url).searchParams.get('input') ?? '{}');
        if (input.json.cardAccountId === 'card-2') {
          await delay(50);
          return result({ ...bill, total: 90, unpaidTotal: 90 });
        }
        return result(bill);
      }),
    );
    const view = renderDialog();
    expect(await screen.findByText(/300,00/)).toBeInTheDocument();
    view.rerender(view.ui({ ...target, cardId: 'card-2', cardName: 'Outro cartão' }));
    expect(screen.queryByText(/300,00/)).not.toBeInTheDocument();
    expect(await screen.findByText(/90,00/)).toBeInTheDocument();
    expect(screen.getByText('Outro cartão')).toBeInTheDocument();
  });
});
