/**
 * OneTimeEventLeverEditor test (Task 24).
 *
 * The editor is pure (no tRPC), so it renders directly under the NextIntl
 * provider (`renderWithProviders`, pt-BR messages). Base UI's Select mounts its
 * options only when the trigger is opened and is not drivable with bare
 * `fireEvent` in jsdom, so the direction picker is driven with `userEvent` +
 * `getByRole('option')` (mirrors LoanPayoffLeverEditor.test.tsx).
 */
import type { SimLever } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { OneTimeEventLeverEditor } from './OneTimeEventLeverEditor';

function setup(value: SimLever | null = null) {
  const onSubmit = vi.fn<(lever: SimLever) => void>();
  renderWithProviders(
    <OneTimeEventLeverEditor value={value} onSubmit={onSubmit} onCancel={vi.fn()} />,
  );
  return { onSubmit };
}

describe('OneTimeEventLeverEditor', () => {
  it('emits a one_time_event with sign, amount, month and label', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByLabelText(/descrição/i), 'Bônus');
    await user.type(screen.getByLabelText(/valor/i), '500.00');
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'one_time_event') throw new Error('wrong kind');
    expect(lever.sign).toBe('outflow'); // default
    expect(lever.amount).toBe('500.00');
    expect(lever.label).toBe('Bônus');
    expect(lever.month).toEqual({ month: expect.any(Number), year: expect.any(Number) });
    expect(lever.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('normalizes a non-decimal amount to the canonical money string (H1)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByLabelText(/valor/i), '5000');
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'one_time_event') throw new Error('wrong kind');
    expect(lever.amount).toBe('5000.00');
  });

  it('keeps submit disabled on a blank or invalid amount', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    // Blank amount: disabled.
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
    // Non-numeric amount: still disabled.
    await user.type(screen.getByLabelText(/valor/i), 'abc');
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('switches the sign to inflow', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByLabelText(/valor/i), '100.00');
    await user.click(await screen.findByLabelText(/direção/i));
    await user.click(await screen.findByRole('option', { name: /entrada/i }));
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'one_time_event') throw new Error('wrong kind');
    expect(lever.sign).toBe('inflow');
    expect(lever.amount).toBe('100.00');
  });

  it('preserves the lever id when editing an existing one_time_event', async () => {
    const user = userEvent.setup();
    const existing: SimLever = {
      kind: 'one_time_event',
      id: '22222222-2222-2222-2222-222222222222',
      sign: 'inflow',
      amount: '750.00',
      month: { month: 9, year: 2027 },
      label: 'Reembolso',
    };
    const { onSubmit } = setup(existing);

    const amount = screen.getByLabelText(/valor/i);
    expect(amount).toHaveValue('750.00');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'one_time_event') throw new Error('wrong kind');
    expect(lever.id).toBe('22222222-2222-2222-2222-222222222222');
    expect(lever.sign).toBe('inflow');
    expect(lever.amount).toBe('750.00');
    expect(lever.month).toEqual({ month: 9, year: 2027 });
    expect(lever.label).toBe('Reembolso');
  });
});
