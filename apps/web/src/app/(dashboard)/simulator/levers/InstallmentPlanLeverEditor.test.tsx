/**
 * InstallmentPlanLeverEditor test (Task 8).
 *
 * The `installment_plan` lever is a finite plan: `amount` charged each month for
 * `installments` months from `startMonth`. The editor surfaces history-based
 * suggestions (recent recurring purchases) from
 * `trpc.simulator.installmentSuggestions`, stubbed here via the shared msw
 * `server` with a superjson payload (matching the production transformer).
 * Unlike the average editors there is no auto-prefill — the amount/installments
 * start blank and are filled by clicking a suggestion or by manual entry.
 */
import type { InstallmentSuggestion, SimLever } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { server } from '../../../../test/msw-server';
import { InstallmentPlanLeverEditor } from './InstallmentPlanLeverEditor';

const suggestions: InstallmentSuggestion[] = [
  { label: 'Notebook', amount: '500.00', installments: 12 },
  { label: 'Geladeira', amount: '200.00', installments: 5 },
];

function stubSuggestions(data: InstallmentSuggestion[] = suggestions) {
  server.use(
    http.get(`${TRPC_TEST_URL}/simulator.installmentSuggestions`, () =>
      HttpResponse.json({ result: { data: superjson.serialize(data) } }),
    ),
  );
}

function setup(value: SimLever | null = null) {
  const onSubmit = vi.fn<(lever: SimLever) => void>();
  stubSuggestions();
  renderWithProviders(
    <TRPCTestProvider>
      <InstallmentPlanLeverEditor value={value} onSubmit={onSubmit} onCancel={vi.fn()} />
    </TRPCTestProvider>,
  );
  return { onSubmit };
}

describe('InstallmentPlanLeverEditor', () => {
  it('renders the history-based suggestions', async () => {
    setup();
    expect(await screen.findByText(/Notebook/)).toBeInTheDocument();
    expect(await screen.findByText(/Geladeira/)).toBeInTheDocument();
  });

  it('fills the amount and installments when a suggestion is clicked', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(await screen.findByRole('button', { name: /notebook/i }));

    expect(screen.getByLabelText(/valor da parcela/i)).toHaveValue('500.00');
    expect(screen.getByLabelText(/número de parcelas/i)).toHaveValue(12);
  });

  it('emits an installment_plan lever from a manual fill', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(await screen.findByLabelText(/valor da parcela/i), '350.00');
    await user.type(screen.getByLabelText(/número de parcelas/i), '8');
    await user.type(screen.getByLabelText(/descrição/i), 'Sofá');

    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'installment_plan') throw new Error('wrong kind');
    expect(lever.amount).toBe('350.00');
    expect(lever.installments).toBe(8);
    expect(lever.label).toBe('Sofá');
    expect(lever.startMonth).toEqual({ month: expect.any(Number), year: expect.any(Number) });
    expect(lever.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('normalizes a non-decimal amount to the canonical money string (H1)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(await screen.findByLabelText(/valor da parcela/i), '5000');
    await user.type(screen.getByLabelText(/número de parcelas/i), '8');
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'installment_plan') throw new Error('wrong kind');
    expect(lever.amount).toBe('5000.00');
  });

  it('disables submit until a valid amount and installment count are present', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    const submit = await screen.findByRole('button', { name: /adicionar/i });
    expect(submit).toBeDisabled();

    // A non-numeric amount with a valid count keeps it disabled.
    await user.type(screen.getByLabelText(/valor da parcela/i), 'abc');
    await user.type(screen.getByLabelText(/número de parcelas/i), '8');
    expect(submit).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/valor da parcela/i));
    await user.type(screen.getByLabelText(/valor da parcela/i), '350.00');
    expect(submit).toBeEnabled();
  });

  it('preserves the lever id when editing an existing installment_plan', async () => {
    const user = userEvent.setup();
    const existing: SimLever = {
      kind: 'installment_plan',
      id: '55555555-5555-5555-5555-555555555555',
      amount: '900.00',
      installments: 6,
      startMonth: { month: 9, year: 2027 },
      label: 'Plano',
    };
    const { onSubmit } = setup(existing);

    expect(await screen.findByLabelText(/valor da parcela/i)).toHaveValue('900.00');
    expect(screen.getByLabelText(/número de parcelas/i)).toHaveValue(6);

    await user.click(screen.getByRole('button', { name: /salvar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'installment_plan') throw new Error('wrong kind');
    expect(lever.id).toBe('55555555-5555-5555-5555-555555555555');
    expect(lever.amount).toBe('900.00');
    expect(lever.installments).toBe(6);
    expect(lever.startMonth).toEqual({ month: 9, year: 2027 });
    expect(lever.label).toBe('Plano');
  });
});
