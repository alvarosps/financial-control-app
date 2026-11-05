import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { MarkAsReceivedDialog } from '../MarkAsReceivedDialog';

describe('payroll receipt review', () => {
  it('requires explicit date and selection, and permits a documented zero net deposit', async () => {
    const onConfirm = vi.fn();
    let received: unknown;
    server.use(
      http.get(`${TRPC_TEST_URL}/income.payrollOptions`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              candidates: [
                {
                  transactionId: '22222222-2222-4222-8222-222222222222',
                  description: 'Payroll installment',
                  date: new Date('2026-06-10'),
                  amount: '100.00',
                  loanAccountId: '33333333-3333-4333-8333-333333333333',
                },
              ],
              allocations: [],
              cashAmount: null,
            }),
          },
        }),
      ),
      http.post(`${TRPC_TEST_URL}/income.settlePayroll`, async ({ request }) => {
        received = superjson.deserialize(
          (await request.json()) as ReturnType<typeof superjson.serialize>,
        );
        return HttpResponse.json({ result: { data: superjson.serialize({ status: 'settled' }) } });
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <MarkAsReceivedDialog
          open
          onOpenChange={() => {}}
          transactionId="11111111-1111-4111-8111-111111111111"
          grossBrl="100.00"
          walletId="44444444-4444-4444-8444-444444444444"
          setWalletId={() => {}}
          wallets={[{ id: '44444444-4444-4444-8444-444444444444', name: 'Bank' }]}
          occurrenceLabel="Salary"
          onConfirm={onConfirm}
          isPending={false}
        />
      </TRPCTestProvider>,
    );
    const selection = await screen.findByRole('checkbox', { name: /Payroll installment/ });
    expect(selection).not.toBeChecked();
    expect(screen.getByLabelText('Data efetiva do recebimento')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    fireEvent.click(selection);
    fireEvent.change(screen.getByLabelText('Data efetiva do recebimento'), {
      target: { value: '2026-06-15' },
    });
    fireEvent.change(screen.getByLabelText('Líquido no contracheque/extrato (opcional)'), {
      target: { value: '0,00' },
    });
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() =>
      expect(received).toMatchObject({
        reportedNetBrl: '0.00',
        loanTransactionIds: ['22222222-2222-4222-8222-222222222222'],
        settlementDate: new Date('2026-06-15T00:00:00-03:00'),
      }),
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
