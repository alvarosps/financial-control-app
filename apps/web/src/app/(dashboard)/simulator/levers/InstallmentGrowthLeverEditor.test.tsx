/**
 * InstallmentGrowthLeverEditor test (Task 9).
 *
 * The `installment_growth` lever is amount-driven (a recurring installment
 * burden: a NEW installment of `monthlyAmount` begins each month from
 * `fromMonth` and each one lasts `termMonths`, default 12 — a rolling window).
 * The editor pre-fills `monthlyAmount` with the user's historical
 * `averageNewInstallment` and explains the rolling window — both sourced from
 * `trpc.simulator.monthlyAverages`, stubbed here via the shared msw `server`
 * with a superjson payload (matching the production transformer).
 *
 * Base UI's Select mounts its options only when the trigger is opened and is
 * not drivable with bare `fireEvent` in jsdom, so the month picker is driven
 * with `userEvent` + `getByRole('option')` (mirrors AverageSpendLeverEditor.test.tsx).
 */
import type { MonthlyAverages, SimLever } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { server } from '../../../../test/msw-server';
import { InstallmentGrowthLeverEditor } from './InstallmentGrowthLeverEditor';

const averages: MonthlyAverages = {
  window: 12,
  monthsWithData: 6,
  monthsUsed: 6,
  averageMonthlySpend: '5000.00',
  rawAverageMonthlySpend: '5000.00',
  averageNewInstallment: '500.00',
  byCategory: {
    creditCard: '2000.00',
    loan: '1000.00',
    charge: '1500.00',
    other: '500.00',
  },
  excludedMonths: [],
};

function stubMonthlyAverages(data: MonthlyAverages = averages) {
  server.use(
    http.get(`${TRPC_TEST_URL}/simulator.monthlyAverages`, () =>
      HttpResponse.json({ result: { data: superjson.serialize(data) } }),
    ),
  );
}

function setup(value: SimLever | null = null) {
  const onSubmit = vi.fn<(lever: SimLever) => void>();
  stubMonthlyAverages();
  renderWithProviders(
    <TRPCTestProvider>
      <InstallmentGrowthLeverEditor value={value} onSubmit={onSubmit} onCancel={vi.fn()} />
    </TRPCTestProvider>,
  );
  return { onSubmit };
}

describe('InstallmentGrowthLeverEditor', () => {
  it('defaults the monthly amount to the historical averageNewInstallment', async () => {
    setup();
    const amount = await screen.findByLabelText(/nova parcela por mês/i);
    await waitFor(() => expect(amount).toHaveValue('500.00'));
  });

  it('shows the rolling-window explanation note', async () => {
    setup();
    // installmentNote carries the entered monthlyAmount ({value}) and the term
    // ({term}, default 12) via ICU args.
    await waitFor(() => expect(screen.getByText(/cada uma dura 12 meses/i)).toBeInTheDocument());
  });

  it('defaults the installment term to 12 and emits it (editable)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const amount = await screen.findByLabelText(/nova parcela por mês/i);
    await waitFor(() => expect(amount).toHaveValue('500.00'));

    const term = screen.getByLabelText(/número de parcelas/i);
    expect(term).toHaveValue('12');
    await user.clear(term);
    await user.type(term, '6');

    await user.click(screen.getByRole('button', { name: /adicionar/i }));
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'installment_growth') throw new Error('wrong kind');
    expect(lever.termMonths).toBe(6);
  });

  it('emits an installment_growth lever with the entered monthlyAmount + fromMonth', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const amount = await screen.findByLabelText(/nova parcela por mês/i);
    await waitFor(() => expect(amount).toHaveValue('500.00'));
    await user.clear(amount);
    await user.type(amount, '300.00');
    await user.type(screen.getByLabelText(/descrição/i), 'Parcelas novas');

    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'installment_growth') throw new Error('wrong kind');
    expect(lever.monthlyAmount).toBe('300.00');
    expect(lever.termMonths).toBe(12);
    expect(lever.label).toBe('Parcelas novas');
    expect(lever.fromMonth).toEqual({ month: expect.any(Number), year: expect.any(Number) });
    expect(lever.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('normalizes a non-decimal monthly amount to the canonical money string (H1)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const amount = await screen.findByLabelText(/nova parcela por mês/i);
    await waitFor(() => expect(amount).toHaveValue('500.00'));
    await user.clear(amount);
    await user.type(amount, '5000');

    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'installment_growth') throw new Error('wrong kind');
    expect(lever.monthlyAmount).toBe('5000.00');
  });

  it('keeps submit disabled on a blank or invalid monthly amount', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const amount = await screen.findByLabelText(/nova parcela por mês/i);
    await waitFor(() => expect(amount).toHaveValue('500.00'));
    await user.clear(amount);
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
    await user.type(amount, 'abc');
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('"Usar média" fills the monthly amount with the historical value', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const amount = await screen.findByLabelText(/nova parcela por mês/i);
    await waitFor(() => expect(amount).toHaveValue('500.00'));
    await user.clear(amount);
    expect(amount).toHaveValue('');
    await user.click(screen.getByRole('button', { name: /usar média/i }));
    expect(amount).toHaveValue('500.00');

    await user.click(screen.getByRole('button', { name: /adicionar/i }));
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'installment_growth') throw new Error('wrong kind');
    expect(lever.monthlyAmount).toBe('500.00');
  });

  it('preserves the lever id when editing an existing installment_growth', async () => {
    const user = userEvent.setup();
    const existing: SimLever = {
      kind: 'installment_growth',
      id: '55555555-5555-5555-5555-555555555555',
      monthlyAmount: '420.00',
      fromMonth: { month: 9, year: 2027 },
      label: 'Parcela nova/mês',
    };
    const { onSubmit } = setup(existing);

    const amount = await screen.findByLabelText(/nova parcela por mês/i);
    // The edited value wins over the historical default.
    expect(amount).toHaveValue('420.00');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'installment_growth') throw new Error('wrong kind');
    expect(lever.id).toBe('55555555-5555-5555-5555-555555555555');
    expect(lever.monthlyAmount).toBe('420.00');
    expect(lever.fromMonth).toEqual({ month: 9, year: 2027 });
    expect(lever.label).toBe('Parcela nova/mês');
  });
});
