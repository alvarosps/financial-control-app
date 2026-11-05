import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { renderDialog } from '@/test/dialog';
import { stubFinancialWallets } from '@/test/financial-fixtures';
import { server } from '@/test/msw-server';
import { TRPC_TEST_URL } from '@/test/trpc';
import { AdjustBalanceDialog } from '../AdjustBalanceDialog';

describe('reviewed balance adjustment', () => {
  it('rejects malformed input and submits a negative BRL balance with the reviewed revision', async () => {
    stubFinancialWallets();
    const calls: unknown[] = [];
    const onOpenChange = vi.fn();
    server.use(
      http.post(`${TRPC_TEST_URL}/account.reanchorWallet`, async ({ request }) => {
        calls.push(
          superjson.deserialize(
            (await request.json()) as Parameters<typeof superjson.deserialize>[0],
          ),
        );
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    renderDialog(
      <AdjustBalanceDialog
        open
        onOpenChange={onOpenChange}
        walletId="wallet-1"
        currentCash={1000}
      />,
    );
    await screen.findByText(/Conta Corrente/);
    const input = screen.getByLabelText(/Saldo atual/);
    const reason = screen.getByLabelText(/Motivo/);
    fireEvent.change(reason, { target: { value: 'Conferido no extrato' } });
    fireEvent.change(input, { target: { value: 'abc123' } });
    const form = input.closest('form');
    if (!form) throw new Error('Missing adjustment form');
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(input).toHaveValue('abc123');
    fireEvent.change(input, { target: { value: '-9.951,85' } });
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      id: 'wallet-1',
      cash: '-9951.85',
      reason: 'Conferido no extrato',
      expectedRevision: 'b'.repeat(64),
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
