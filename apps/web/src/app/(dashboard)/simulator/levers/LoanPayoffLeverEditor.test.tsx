/**
 * LoanPayoffLeverEditor test (Task 23).
 *
 * Drives the real editor under the NextIntl + tRPC provider stack (pt-BR
 * messages via `renderWithProviders`). `trpc.loan.list` is a query, so it
 * arrives as a GET that we stub via the shared msw `server` with a
 * superjson-serialized payload (matching the production transformer).
 *
 * Base UI's Select mounts its options only when the trigger is opened and is
 * not drivable with bare `fireEvent` in jsdom, so the loan + month pickers are
 * driven with `userEvent` + `getByRole('option')` (mirrors
 * components/income/__tests__/AddIncomeSourceDialog.test.tsx).
 */
import type { SimLever } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { server } from '../../../../test/msw-server';
import { LoanPayoffLeverEditor } from './LoanPayoffLeverEditor';

const loanList = [
  {
    account: { id: 'loan-1', name: 'Car loan' },
    config: { id: 'cfg-1' },
    schedule: null,
    currentInstallment: 3,
    overdueCount: 0,
    isCurrentMonthPaid: true,
  },
  {
    account: { id: 'acc-no-config', name: 'No config' },
    config: null,
    schedule: null,
    currentInstallment: 0,
    overdueCount: 0,
    isCurrentMonthPaid: true,
  },
];

function stubLoanList() {
  server.use(
    http.get(`${TRPC_TEST_URL}/loan.list`, () =>
      HttpResponse.json({ result: { data: superjson.serialize(loanList) } }),
    ),
  );
}

function setup(value: SimLever | null = null) {
  const onSubmit = vi.fn<(lever: SimLever) => void>();
  stubLoanList();
  renderWithProviders(
    <TRPCTestProvider>
      <LoanPayoffLeverEditor value={value} onSubmit={onSubmit} onCancel={vi.fn()} />
    </TRPCTestProvider>,
  );
  return { onSubmit };
}

describe('LoanPayoffLeverEditor', () => {
  it('only lists loans that have a config', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByLabelText(/empréstimo/i));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Car loan' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'No config' })).not.toBeInTheDocument();
  });

  it('emits a loan_payoff lever with the selected loan, month and partial amount', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/empréstimo/i));
    await user.click(await screen.findByRole('option', { name: 'Car loan' }));

    const partial = screen.getByLabelText(/valor acordado para quitação total/i);
    await user.clear(partial);
    await user.type(partial, '5000.00');

    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const lever = onSubmit.mock.calls[0][0];
    expect(lever.kind).toBe('loan_payoff');
    if (lever.kind !== 'loan_payoff') throw new Error('wrong kind');
    expect(lever.loanAccountId).toBe('loan-1');
    expect(lever.partialAmount).toBe('5000.00');
    expect(lever.targetMonth).toEqual({ month: expect.any(Number), year: expect.any(Number) });
    expect(lever.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('normalizes a non-decimal partial amount to the canonical money string (H1)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/empréstimo/i));
    await user.click(await screen.findByRole('option', { name: 'Car loan' }));

    const partial = screen.getByLabelText(/valor acordado para quitação total/i);
    await user.clear(partial);
    await user.type(partial, '5000');

    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'loan_payoff') throw new Error('wrong kind');
    expect(lever.partialAmount).toBe('5000.00');
  });

  it('keeps submit disabled on a non-empty-but-invalid partial amount', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/empréstimo/i));
    await user.click(await screen.findByRole('option', { name: 'Car loan' }));

    await user.type(screen.getByLabelText(/valor acordado para quitação total/i), 'abc');
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('defaults a fresh lever targetMonth to next month', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/empréstimo/i));
    await user.click(await screen.findByRole('option', { name: 'Car loan' }));
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'loan_payoff') throw new Error('wrong kind');
    const now = new Date();
    const expectedMonth = now.getMonth() + 2;
    const expected =
      expectedMonth > 12
        ? { month: expectedMonth - 12, year: now.getFullYear() + 1 }
        : { month: expectedMonth, year: now.getFullYear() };
    expect(lever.targetMonth).toEqual(expected);
  });

  it('omits partialAmount when left blank (full payoff)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/empréstimo/i));
    await user.click(await screen.findByRole('option', { name: 'Car loan' }));
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'loan_payoff') throw new Error('wrong kind');
    expect(lever.partialAmount).toBeUndefined();
  });

  it('preserves the lever id when editing an existing loan_payoff', async () => {
    const user = userEvent.setup();
    const existing: SimLever = {
      kind: 'loan_payoff',
      id: '11111111-1111-1111-1111-111111111111',
      loanAccountId: 'loan-1',
      targetMonth: { month: 8, year: 2027 },
      partialAmount: '1000.00',
    };
    const { onSubmit } = setup(existing);

    // The partial-amount field is a plain Input (renders synchronously, no
    // dropdown needed), so its pre-filled draft confirms the editor hydrated
    // from the edited lever before we submit.
    const partial = await screen.findByLabelText(/valor acordado para quitação total/i);
    expect(partial).toHaveValue('1000.00');
    // Editing an existing lever shows the Save label, not Add (M7).
    expect(screen.queryByRole('button', { name: /adicionar/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'loan_payoff') throw new Error('wrong kind');
    expect(lever.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(lever.loanAccountId).toBe('loan-1');
    expect(lever.targetMonth).toEqual({ month: 8, year: 2027 });
    expect(lever.partialAmount).toBe('1000.00');
  });
});
