/**
 * RecurringLeverEditor test (Task 25).
 *
 * The `cancel` op lists the user's ACTIVE scheduled transactions
 * (`trpc.scheduled.list`, filtered to `isActive`) as a multi-select; each
 * checked schedule emits its own `recurring_change` lever (one per
 * `scheduledTransactionId`), so the editor's `onSubmit` is called once per
 * selection. The schedule list is stubbed via the shared msw `server` with a
 * superjson payload (matching the production transformer).
 *
 * The `add` op is pure (amount + frequency + start month + label) and
 * emits a single `recurring_change` lever. Base UI's Select mounts its options
 * only when the trigger is opened and is not drivable with bare `fireEvent` in
 * jsdom, so the op/frequency pickers are driven with `userEvent` +
 * `getByRole('option')` (mirrors the sibling editors). Tests render under the
 * pt-BR provider, so user-facing copy is asserted in Portuguese.
 */
import type { SimLever } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { server } from '../../../../test/msw-server';
import { RecurringLeverEditor } from './RecurringLeverEditor';

const scheduledList = [
  { id: 'sch-1', description: 'Academia', amount: '120.00', frequency: 'monthly', isActive: true },
  { id: 'sch-2', description: 'Netflix', amount: '55.00', frequency: 'monthly', isActive: true },
  { id: 'sch-3', description: 'Antigo', amount: '10.00', frequency: 'monthly', isActive: false },
];

function stubScheduledList() {
  server.use(
    http.get(`${TRPC_TEST_URL}/scheduled.list`, () =>
      HttpResponse.json({ result: { data: superjson.serialize(scheduledList) } }),
    ),
  );
}

function setup(value: SimLever | null = null) {
  const onSubmit = vi.fn<(lever: SimLever) => void>();
  stubScheduledList();
  renderWithProviders(
    <TRPCTestProvider>
      <RecurringLeverEditor value={value} onSubmit={onSubmit} onCancel={vi.fn()} />
    </TRPCTestProvider>,
  );
  return { onSubmit };
}

describe('RecurringLeverEditor', () => {
  it('lists only active schedules for cancel and emits one lever per checked item', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await waitFor(() => expect(screen.getByLabelText(/Academia/)).toBeInTheDocument());
    // The inactive schedule is filtered out of the multi-select.
    expect(screen.queryByLabelText(/Antigo/)).not.toBeInTheDocument();

    await user.click(screen.getByLabelText(/Academia/));
    await user.click(screen.getByLabelText(/Netflix/));
    await user.click(screen.getByRole('button', { name: /^adicionar$/i }));

    expect(onSubmit).toHaveBeenCalledTimes(2);
    const ids = onSubmit.mock.calls.map((call) => {
      const lever = call[0];
      if (lever.kind !== 'recurring_change') throw new Error('wrong kind');
      return lever.scheduledTransactionId;
    });
    expect(ids).toEqual(['sch-1', 'sch-2']);

    for (const call of onSubmit.mock.calls) {
      const lever = call[0];
      if (lever.kind !== 'recurring_change') throw new Error('wrong kind');
      expect(lever.op).toBe('cancel');
      expect(lever.id).toMatch(/[0-9a-f-]{36}/);
    }
    // Each cancel lever defaults its label to the schedule description.
    const labels = onSubmit.mock.calls.map((call) => {
      const lever = call[0];
      if (lever.kind !== 'recurring_change') throw new Error('wrong kind');
      return lever.label;
    });
    expect(labels).toEqual(['Academia', 'Netflix']);
  });

  it('emits a single add recurring_change with amount, frequency and month', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/operação/i));
    await user.click(await screen.findByRole('option', { name: /adicionar novo recorrente/i }));

    await user.type(screen.getByLabelText(/descrição/i), 'Nova assinatura');
    await user.type(screen.getByLabelText(/valor/i), '30.00');
    await user.click(screen.getByRole('button', { name: /^adicionar$/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'recurring_change') throw new Error('wrong kind');
    expect(lever.op).toBe('add');
    expect(lever.amount).toBe('30.00');
    expect(lever.frequency).toBe('monthly');
    expect(lever.label).toBe('Nova assinatura');
    expect(lever.scheduledTransactionId).toBeUndefined();
    expect(lever.startMonth).toEqual({ month: expect.any(Number), year: expect.any(Number) });
    expect(lever.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('normalizes a non-decimal add amount to the canonical money string (H1)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/operação/i));
    await user.click(await screen.findByRole('option', { name: /adicionar novo recorrente/i }));

    await user.type(screen.getByLabelText(/valor/i), '5000');
    await user.click(screen.getByRole('button', { name: /^adicionar$/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'recurring_change') throw new Error('wrong kind');
    expect(lever.amount).toBe('5000.00');
  });

  it('keeps submit disabled on a blank or invalid add amount', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/operação/i));
    await user.click(await screen.findByRole('option', { name: /adicionar novo recorrente/i }));

    expect(screen.getByRole('button', { name: /^adicionar$/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/valor/i), 'abc');
    expect(screen.getByRole('button', { name: /^adicionar$/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reuses the original id when editing a single-schedule cancel lever (M6)', async () => {
    const existing: SimLever = {
      kind: 'recurring_change',
      id: '66666666-6666-6666-6666-666666666666',
      op: 'cancel',
      scheduledTransactionId: 'sch-1',
      label: 'Academia',
    };
    const user = userEvent.setup();
    const { onSubmit } = setup(existing);

    // The edited schedule is pre-checked; submitting REPLACES the lever instead
    // of minting an orphan, so the emitted lever reuses the original id.
    await waitFor(() => expect(screen.getByLabelText(/Academia/)).toBeChecked());
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'recurring_change') throw new Error('wrong kind');
    expect(lever.op).toBe('cancel');
    expect(lever.scheduledTransactionId).toBe('sch-1');
    expect(lever.id).toBe('66666666-6666-6666-6666-666666666666');
  });

  it('emits an add recurring_change with a non-monthly frequency', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(await screen.findByLabelText(/operação/i));
    await user.click(await screen.findByRole('option', { name: /adicionar novo recorrente/i }));

    await user.type(screen.getByLabelText(/valor/i), '200.00');
    await user.click(await screen.findByLabelText(/frequência/i));
    await user.click(await screen.findByRole('option', { name: /^semanal$/i }));
    await user.click(screen.getByRole('button', { name: /^adicionar$/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'recurring_change') throw new Error('wrong kind');
    expect(lever.op).toBe('add');
    expect(lever.amount).toBe('200.00');
    expect(lever.frequency).toBe('weekly');
    // Label falls back to the default when left blank.
    expect(lever.label).toBe('Novo recorrente');
  });

  it('preserves the lever id when editing an existing add recurring_change', async () => {
    const user = userEvent.setup();
    const existing: SimLever = {
      kind: 'recurring_change',
      id: '44444444-4444-4444-4444-444444444444',
      op: 'add',
      amount: '99.00',
      frequency: 'monthly',
      startMonth: { month: 9, year: 2027 },
      label: 'Spotify',
    };
    const { onSubmit } = setup(existing);

    const amount = await screen.findByLabelText(/valor/i);
    expect(amount).toHaveValue('99.00');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'recurring_change') throw new Error('wrong kind');
    expect(lever.id).toBe('44444444-4444-4444-4444-444444444444');
    expect(lever.amount).toBe('99.00');
    expect(lever.startMonth).toEqual({ month: 9, year: 2027 });
    expect(lever.label).toBe('Spotify');
  });
});
