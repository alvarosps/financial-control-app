/**
 * SavingsGoalLeverEditor test (Task 26).
 *
 * The editor is pure (no tRPC), so it renders directly under the NextIntl
 * provider (`renderWithProviders`, pt-BR messages). The month/year picker is a
 * Base UI Select, so the by-month value is asserted via its pre-filled default
 * rather than driven here — the lever shape (target + byMonth + label) and id
 * preservation are what this task verifies.
 */
import type { SimLever } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { SavingsGoalLeverEditor } from './SavingsGoalLeverEditor';

function setup(value: SimLever | null = null) {
  const onSubmit = vi.fn<(lever: SimLever) => void>();
  renderWithProviders(
    <SavingsGoalLeverEditor value={value} onSubmit={onSubmit} onCancel={vi.fn()} />,
  );
  return { onSubmit };
}

describe('SavingsGoalLeverEditor', () => {
  it('emits a savings_goal lever with target, byMonth and label', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByLabelText(/descrição/i), 'Reserva');
    await user.type(screen.getByLabelText(/valor da meta/i), '10000.00');
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'savings_goal') throw new Error('wrong kind');
    expect(lever.target).toBe('10000.00');
    expect(lever.label).toBe('Reserva');
    expect(lever.byMonth).toEqual({ month: expect.any(Number), year: expect.any(Number) });
    expect(lever.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('falls back to the default label when none is typed', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByLabelText(/valor da meta/i), '500.00');
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'savings_goal') throw new Error('wrong kind');
    expect(lever.label).toBe('Meta de economia');
    expect(lever.target).toBe('500.00');
  });

  it('normalizes a non-decimal target to the canonical money string (H1)', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByLabelText(/valor da meta/i), '5000');
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'savings_goal') throw new Error('wrong kind');
    expect(lever.target).toBe('5000.00');
  });

  it('disables submit until a valid target is entered', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
    // A non-numeric target keeps it disabled.
    await user.type(screen.getByLabelText(/valor da meta/i), 'abc');
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
  });

  it('pre-fills fields when editing an existing lever and keeps its id', async () => {
    const user = userEvent.setup();
    const existing: SimLever = {
      kind: 'savings_goal',
      id: '55555555-5555-5555-5555-555555555555',
      target: '5000.00',
      byMonth: { month: 12, year: 2026 },
      label: 'Viagem',
    };
    const { onSubmit } = setup(existing);

    const target = screen.getByLabelText(/valor da meta/i);
    expect(target).toHaveValue('5000.00');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    const lever = onSubmit.mock.calls[0][0];
    if (lever.kind !== 'savings_goal') throw new Error('wrong kind');
    expect(lever.id).toBe('55555555-5555-5555-5555-555555555555');
    expect(lever.target).toBe('5000.00');
    expect(lever.byMonth).toEqual({ month: 12, year: 2026 });
    expect(lever.label).toBe('Viagem');
  });
});
