import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { obligationFixture, stubFinancialWallets } from '@/test/financial-fixtures';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { FinancialObligationAction } from '../FinancialObligationAction';

async function openAndFill() {
  await userEvent.click(screen.getByRole('button', { name: 'Registrar pagamento' }));
  await userEvent.click(screen.getByRole('combobox'));
  await userEvent.click(await screen.findByRole('option', { name: 'Conta Corrente' }));
  fireEvent.change(screen.getByLabelText(/Data e hora do pagamento/), {
    target: { value: '2026-09-12T09:00' },
  });
}
describe('exact obligation settlement', () => {
  it('sends the displayed loan occurrence and effective date once; waits for confirmation', async () => {
    stubFinancialWallets();
    const calls: unknown[] = [];
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.use(
      http.post(`${TRPC_TEST_URL}/loan.markOccurrenceAsPaid`, async ({ request }) => {
        calls.push(
          superjson.deserialize(
            (await request.json()) as Parameters<typeof superjson.deserialize>[0],
          ),
        );
        await gate;
        return HttpResponse.json({ result: { data: superjson.serialize({ ok: true }) } });
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <FinancialObligationAction item={obligationFixture} />
      </TRPCTestProvider>,
    );
    await openAndFill();
    const submit = screen.getAllByRole('button', { name: 'Registrar pagamento' }).at(-1);
    if (!submit) throw new Error('submit missing');
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.dblClick(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      accountId: 'loan-1',
      transactionId: 'installment-september',
      paidFromAccountId: 'wallet-1',
      settlementDate: new Date('2026-09-12T12:00:00Z'),
      expectedRevision: obligationFixture.revision,
    });
    expect(submit).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('blocks a payment covered by the observed balance before sending it', async () => {
    stubFinancialWallets('2026-09-30T12:00:00Z');
    renderWithProviders(
      <TRPCTestProvider>
        <FinancialObligationAction item={obligationFixture} />
      </TRPCTestProvider>,
    );
    await openAndFill();
    expect(await screen.findByText(/confirmação exige conciliação histórica/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Registrar pagamento' }).at(-1)).toBeDisabled();
  });
});
