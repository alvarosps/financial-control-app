/**
 * IncomeLeverEditor test (Task 24).
 *
 * The `add` op is pure (a plain amount + frequency + months), but `adjust` and
 * `end` are BASELINE-RELATIVE: they let the user pick one of their real income
 * sources so the emitted lever's `amount` is the source's monthly BRL figure
 * (the resolver is amount-driven and has no baseline of its own). The source
 * picker is sourced from `trpc.income.list`, stubbed here via the shared msw
 * `server` with a superjson payload (matching the production transformer).
 *
 * Base UI's Select mounts its options only when the trigger is opened and is
 * not drivable with bare `fireEvent` in jsdom, so the op / frequency / source
 * pickers are driven with `userEvent` + `getByRole('option')` (mirrors
 * LoanPayoffLeverEditor.test.tsx).
 */
import type { SimLever } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { server } from '../../../../test/msw-server';
import { IncomeLeverEditor } from './IncomeLeverEditor';

// Two real income sources: a monthly BRL salary (5000.00/mo) and a weekly
// freelance (200.00 × 4 = 800.00/mo). The editor must resolve each to its
// monthly BRL figure when it is picked for an adjust/end lever.
const incomeList = [
  {
    account: { id: 'src-salary', name: 'Salário', currency: 'BRL' },
    config: { frequency: 'monthly', exchangeRate: null, conversionFeePercent: null },
    schedule: { amount: '5000.00', startDate: '2026-01-01' },
  },
  {
    account: { id: 'src-free', name: 'Freela', currency: 'BRL' },
    config: { frequency: 'weekly', exchangeRate: null, conversionFeePercent: null },
    schedule: { amount: '200.00', startDate: '2026-01-01' },
  },
];

function stubIncomeList() {
  server.use(
    http.get(`${TRPC_TEST_URL}/income.list`, () =>
      HttpResponse.json({ result: { data: superjson.serialize(incomeList) } }),
    ),
  );
}

function setup(value: SimLever | null = null) {
  const onSubmit = vi.fn<(lever: SimLever) => void>();
  stubIncomeList();
  renderWithProviders(
    <TRPCTestProvider>
      <IncomeLeverEditor value={value} onSubmit={onSubmit} onCancel={vi.fn()} />
    </TRPCTestProvider>,
  );
  return { onSubmit };
}

describe('IncomeLeverEditor', () => {
  it('emits an add income_change with amount + frequency (default monthly)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByLabelText(/descrição/i), 'Bico');
    await user.type(screen.getByLabelText(/valor/i), '800.00');
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'income_change') throw new Error('wrong kind');
    expect(lever.op).toBe('add');
    expect(lever.amount).toBe('800.00');
    expect(lever.frequency).toBe('monthly');
    expect(lever.label).toBe('Bico');
    expect(lever.percent).toBeUndefined();
    expect(lever.fromMonth).toEqual({ month: expect.any(Number), year: expect.any(Number) });
    expect(lever.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('normalizes a non-decimal add amount to the canonical money string (H1)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByLabelText(/valor/i), '5000');
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'income_change') throw new Error('wrong kind');
    expect(lever.op).toBe('add');
    expect(lever.amount).toBe('5000.00');
  });

  it('keeps submit disabled on a blank or invalid add amount', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/valor/i), 'abc');
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('adjust: keeps submit disabled on a non-finite percent and never emits NaN (H2)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/operação/i));
    await user.click(await screen.findByRole('option', { name: /ajustar/i }));
    await user.click(await screen.findByLabelText(/fonte de renda/i));
    await user.click(await screen.findByRole('option', { name: 'Salário' }));

    // A source is picked but the percent is non-numeric: submit stays disabled
    // so no NaN percent is emitted.
    await user.type(screen.getByLabelText(/percentual/i), 'abc');
    await waitFor(() => expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('adjust: keeps submit disabled when the percent is blank', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/operação/i));
    await user.click(await screen.findByRole('option', { name: /ajustar/i }));
    await user.click(await screen.findByLabelText(/fonte de renda/i));
    await user.click(await screen.findByRole('option', { name: 'Salário' }));

    // Source picked, percent left empty: adjust requires a percent, so disabled.
    await waitFor(() => expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('emits an add income_change with a non-monthly frequency', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByLabelText(/valor/i), '300.00');
    await user.click(await screen.findByLabelText(/frequência/i));
    await user.click(await screen.findByRole('option', { name: /^semanal$/i }));
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'income_change') throw new Error('wrong kind');
    expect(lever.op).toBe('add');
    expect(lever.frequency).toBe('weekly');
    expect(lever.amount).toBe('300.00');
  });

  it('adjust: sources the base amount from the picked income source + percent', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/operação/i));
    await user.click(await screen.findByRole('option', { name: /ajustar/i }));

    // Pick the monthly salary source: monthly figure is 5000.00.
    await user.click(await screen.findByLabelText(/fonte de renda/i));
    await user.click(await screen.findByRole('option', { name: 'Salário' }));

    await user.type(screen.getByLabelText(/percentual/i), '10');
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'income_change') throw new Error('wrong kind');
    expect(lever.op).toBe('adjust');
    expect(lever.amount).toBe('5000.00');
    expect(lever.percent).toBe(10);
    // Label defaults to the source name when left blank.
    expect(lever.label).toBe('Salário');
  });

  it('adjust: resolves a weekly source to its monthly figure (×4)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/operação/i));
    await user.click(await screen.findByRole('option', { name: /ajustar/i }));
    await user.click(await screen.findByLabelText(/fonte de renda/i));
    await user.click(await screen.findByRole('option', { name: 'Freela' }));
    await user.type(screen.getByLabelText(/percentual/i), '5');
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'income_change') throw new Error('wrong kind');
    expect(lever.amount).toBe('800.00'); // 200.00 × 4 weekly
    expect(lever.percent).toBe(5);
  });

  it('end: sets amount to the picked source monthly figure and no percent', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/operação/i));
    await user.click(await screen.findByRole('option', { name: /encerrar/i }));
    await user.click(await screen.findByLabelText(/fonte de renda/i));
    await user.click(await screen.findByRole('option', { name: 'Salário' }));
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'income_change') throw new Error('wrong kind');
    expect(lever.op).toBe('end');
    expect(lever.amount).toBe('5000.00');
    expect(lever.percent).toBeUndefined();
    expect(lever.label).toBe('Salário');
  });

  it('does not emit an adjust lever until a source is selected', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/operação/i));
    await user.click(await screen.findByRole('option', { name: /ajustar/i }));
    await user.type(screen.getByLabelText(/percentual/i), '10');
    // The add button is disabled with no source picked.
    await waitFor(() => expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('preserves the lever id when editing an existing income_change', async () => {
    const user = userEvent.setup();
    const existing: SimLever = {
      kind: 'income_change',
      id: '33333333-3333-3333-3333-333333333333',
      op: 'add',
      amount: '1200.00',
      frequency: 'monthly',
      fromMonth: { month: 8, year: 2027 },
      label: 'Aluguel',
    };
    const { onSubmit } = setup(existing);

    const amount = await screen.findByLabelText(/valor/i);
    expect(amount).toHaveValue('1200.00');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'income_change') throw new Error('wrong kind');
    expect(lever.id).toBe('33333333-3333-3333-3333-333333333333');
    expect(lever.amount).toBe('1200.00');
    expect(lever.fromMonth).toEqual({ month: 8, year: 2027 });
    expect(lever.label).toBe('Aluguel');
  });
});
