/**
 * AverageSpendLeverEditor test (Task 8).
 *
 * The `average_spend` lever is amount-driven (a flat additive monthly expense
 * from `fromMonth` to the horizon end). The editor pre-fills the amount with
 * the user's historical `averageMonthlySpend` and shows the per-category
 * breakdown — both sourced from `trpc.simulator.monthlyAverages`, stubbed here
 * via the shared msw `server` with a superjson payload (matching the production
 * transformer).
 *
 * Base UI's Select mounts its options only when the trigger is opened and is
 * not drivable with bare `fireEvent` in jsdom, so the month picker is driven
 * with `userEvent` + `getByRole('option')` (mirrors IncomeLeverEditor.test.tsx).
 */
import type { MonthlyAverages, SimLever } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { server } from '../../../../test/msw-server';
import { AverageSpendLeverEditor } from './AverageSpendLeverEditor';

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

function setup(value: SimLever | null = null, data: MonthlyAverages = averages) {
  const onSubmit = vi.fn<(lever: SimLever) => void>();
  stubMonthlyAverages(data);
  renderWithProviders(
    <TRPCTestProvider>
      <AverageSpendLeverEditor value={value} onSubmit={onSubmit} onCancel={vi.fn()} />
    </TRPCTestProvider>,
  );
  return { onSubmit };
}

describe('AverageSpendLeverEditor', () => {
  it('shows the historical average and the per-category breakdown', async () => {
    setup();

    // Historical average label carries the BRL figure via the {value} ICU arg.
    expect(await screen.findByText(/5000\.00/)).toBeInTheDocument();
    // Per-category breakdown values are all rendered.
    expect(await screen.findByText(/2000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/1000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/1500\.00/)).toBeInTheDocument();
  });

  it('defaults the amount input to the historical averageMonthlySpend', async () => {
    setup();
    const amount = await screen.findByLabelText(/gasto mensal/i);
    await waitFor(() => expect(amount).toHaveValue('5000.00'));
  });

  it('emits an average_spend lever with the entered amount + fromMonth', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const amount = await screen.findByLabelText(/gasto mensal/i);
    await waitFor(() => expect(amount).toHaveValue('5000.00'));
    await user.clear(amount);
    await user.type(amount, '4200.00');
    await user.type(screen.getByLabelText(/descrição/i), 'Variável');

    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'average_spend') throw new Error('wrong kind');
    expect(lever.amount).toBe('4200.00');
    expect(lever.label).toBe('Variável');
    expect(lever.fromMonth).toEqual({ month: expect.any(Number), year: expect.any(Number) });
    expect(lever.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('normalizes a non-decimal amount to the canonical money string (H1)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const amount = await screen.findByLabelText(/gasto mensal/i);
    await waitFor(() => expect(amount).toHaveValue('5000.00'));
    await user.clear(amount);
    await user.type(amount, '4200');

    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'average_spend') throw new Error('wrong kind');
    expect(lever.amount).toBe('4200.00');
  });

  it('keeps submit disabled on a blank or invalid amount', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const amount = await screen.findByLabelText(/gasto mensal/i);
    await waitFor(() => expect(amount).toHaveValue('5000.00'));
    await user.clear(amount);
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
    await user.type(amount, 'abc');
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('"Usar média" fills the amount with the historical value', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const amount = await screen.findByLabelText(/gasto mensal/i);
    await waitFor(() => expect(amount).toHaveValue('5000.00'));
    // Clear it, then use the affordance to refill from the historical average.
    await user.clear(amount);
    expect(amount).toHaveValue('');
    await user.click(screen.getByRole('button', { name: /usar média/i }));
    expect(amount).toHaveValue('5000.00');

    await user.click(screen.getByRole('button', { name: /adicionar/i }));
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'average_spend') throw new Error('wrong kind');
    expect(lever.amount).toBe('5000.00');
  });

  it('preserves the lever id when editing an existing average_spend', async () => {
    const user = userEvent.setup();
    const existing: SimLever = {
      kind: 'average_spend',
      id: '44444444-4444-4444-4444-444444444444',
      amount: '3300.00',
      fromMonth: { month: 9, year: 2027 },
      label: 'Gasto médio',
    };
    const { onSubmit } = setup(existing);

    const amount = await screen.findByLabelText(/gasto mensal/i);
    // The edited value wins over the historical default.
    expect(amount).toHaveValue('3300.00');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'average_spend') throw new Error('wrong kind');
    expect(lever.id).toBe('44444444-4444-4444-4444-444444444444');
    expect(lever.amount).toBe('3300.00');
    expect(lever.fromMonth).toEqual({ month: 9, year: 2027 });
    expect(lever.label).toBe('Gasto médio');
  });

  it('renders the excluded-months note with the per-reason labels', async () => {
    const withExclusions: MonthlyAverages = {
      ...averages,
      rawAverageMonthlySpend: '6200.00',
      excludedMonths: [
        { month: 5, year: 2026, total: '12000.00', reasons: ['statistical', 'iof'] },
      ],
    };
    setup(null, withExclusions);

    // The exclusion note appears and names the excluded month's reasons.
    expect(await screen.findByText(/excluíd/i)).toBeInTheDocument();
    expect(screen.getByText(/gasto muito acima do normal/i)).toBeInTheDocument();
    expect(screen.getByText(/IOF alto/i)).toBeInTheDocument();
  });

  it('renders the window selector and re-queries when a window is picked', async () => {
    // Branch the stub on the parsed superjson `window` input so the click
    // surfaces a distinct historical figure (the field is still untouched, so
    // the prefill effect refills it).
    const averages3: MonthlyAverages = { ...averages, window: 3, averageMonthlySpend: '3000.00' };
    server.use(
      http.get(`${TRPC_TEST_URL}/simulator.monthlyAverages`, ({ request }) => {
        const raw = new URL(request.url).searchParams.get('input');
        const input = raw ? superjson.parse<{ window?: number }>(raw) : {};
        const data = input.window === 3 ? averages3 : averages;
        return HttpResponse.json({ result: { data: superjson.serialize(data) } });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <TRPCTestProvider>
        <AverageSpendLeverEditor value={null} onSubmit={vi.fn()} onCancel={vi.fn()} />
      </TRPCTestProvider>,
    );

    const amount = await screen.findByLabelText(/gasto mensal/i);
    await waitFor(() => expect(amount).toHaveValue('5000.00'));

    // All three window buttons render; the default (12) is active.
    expect(screen.getByRole('button', { name: /3 meses/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /6 meses/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /12 meses/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /3 meses/i }));
    await waitFor(() => expect(amount).toHaveValue('3000.00'));
  });
});
