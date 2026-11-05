/**
 * LeverPanel shell test (Task 22).
 *
 * The panel is a controlled component: it never holds the lever list itself,
 * it emits the next list through `onChange`. These tests drive the real shell
 * (rendered under the NextIntl provider via `renderWithProviders`, pt-BR
 * messages) and assert the pure `upsertLever`/`removeLever` helpers plus the
 * add/remove/horizon/opening-balance callbacks. The add flow goes through the
 * real `OneTimeEventLeverEditor` placeholder (Task 24 fleshes it out).
 */
import type { SimLever } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, renderWithProviders, screen, waitFor } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { server } from '../../../../test/msw-server';
import { LeverPanel, removeLever, upsertLever } from './LeverPanel';

const oneTime: SimLever = {
  kind: 'one_time_event',
  id: 'lever-1',
  sign: 'outflow',
  amount: '1200.00',
  month: { month: 7, year: 2026 },
  label: 'Car repair',
};

describe('upsertLever / removeLever', () => {
  it('appends a lever with a new id', () => {
    const next = upsertLever([oneTime], { ...oneTime, id: 'lever-2', label: 'Vacation' });
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ id: 'lever-2', label: 'Vacation' });
  });

  it('replaces an existing lever when the id matches', () => {
    const next = upsertLever([oneTime], { ...oneTime, label: 'Updated repair' });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'lever-1', label: 'Updated repair' });
  });

  it('removes the lever with the given id', () => {
    expect(removeLever([oneTime], 'lever-1')).toEqual([]);
  });
});

describe('LeverPanel', () => {
  it('renders the current levers with their labels', () => {
    renderWithProviders(<LeverPanel levers={[oneTime]} onChange={vi.fn()} />);
    expect(screen.getByText('Car repair')).toBeInTheDocument();
  });

  it('removes a lever via its remove button', () => {
    const onChange = vi.fn<(levers: SimLever[]) => void>();
    renderWithProviders(<LeverPanel levers={[oneTime]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/remover alavanca/i));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('adds a lever emitted by an editor (append with a fresh id)', () => {
    const onChange = vi.fn<(levers: SimLever[]) => void>();
    renderWithProviders(<LeverPanel levers={[]} onChange={onChange} />);
    // Open the add menu, pick the one-time event kind, fill + submit.
    fireEvent.click(screen.getByRole('button', { name: /adicionar alavanca/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /evento único/i }));
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '500.00' } });
    fireEvent.change(screen.getByLabelText(/descrição/i), { target: { value: 'Bônus' } });
    fireEvent.click(screen.getByRole('button', { name: /adicionar/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(1);
    const added = next[0];
    expect(added.kind).toBe('one_time_event');
    expect(added.id).toBeTruthy();
    if (added.kind === 'one_time_event') {
      expect(added.label).toBe('Bônus');
      expect(added.amount).toBe('500.00');
    }
  });

  it('accumulates multiple levers emitted in one editor session (multi-cancel)', async () => {
    // The recurring-cancel editor calls onSubmit once per checked schedule. The
    // panel must accumulate them into ONE growing list — not drop all but the
    // last — even though the synchronous emits share a stale `levers` snapshot.
    server.use(
      http.get(`${TRPC_TEST_URL}/scheduled.list`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize([
              { id: 'sch-1', description: 'Academia', amount: '120.00', isActive: true },
              { id: 'sch-2', description: 'Netflix', amount: '55.00', isActive: true },
            ]),
          },
        }),
      ),
    );
    const user = userEvent.setup();
    const onChange = vi.fn<(levers: SimLever[]) => void>();
    renderWithProviders(
      <TRPCTestProvider>
        <LeverPanel levers={[]} onChange={onChange} />
      </TRPCTestProvider>,
    );

    await user.click(screen.getByRole('button', { name: /adicionar alavanca/i }));
    await user.click(screen.getByRole('menuitem', { name: /mudança recorrente/i }));
    await waitFor(() => expect(screen.getByLabelText(/Academia/)).toBeInTheDocument());
    await user.click(screen.getByLabelText(/Academia/));
    await user.click(screen.getByLabelText(/Netflix/));
    await user.click(screen.getByRole('button', { name: /^adicionar$/i }));

    // The final emitted list carries BOTH cancel levers.
    const lastCall = onChange.mock.calls.at(-1);
    if (!lastCall) throw new Error('onChange was never called');
    const finalLevers = lastCall[0];
    expect(finalLevers).toHaveLength(2);
    const cancelledIds = finalLevers.map((lever) => {
      if (lever.kind !== 'recurring_change') throw new Error('wrong kind');
      return lever.scheduledTransactionId;
    });
    expect(cancelledIds).toEqual(['sch-1', 'sch-2']);
  });

  it('fires onHorizonChange when a horizon option is picked', () => {
    const onHorizonChange = vi.fn<(horizon: number) => void>();
    renderWithProviders(
      <LeverPanel
        levers={[]}
        onChange={vi.fn()}
        horizon={12}
        onHorizonChange={onHorizonChange}
        anchorCash={1000}
      />,
    );
    // Anchored: /6 meses/ would also match "36 meses" (substring), so pin it.
    fireEvent.click(screen.getByRole('button', { name: /^6 meses$/i }));
    expect(onHorizonChange).toHaveBeenCalledWith(6);
  });

  it('defaults the opening balance to the anchor cash and fires onOpeningBalanceChange', () => {
    const onOpeningBalanceChange = vi.fn<(value: string | undefined) => void>();
    renderWithProviders(
      <LeverPanel
        levers={[]}
        onChange={vi.fn()}
        anchorCash={1000}
        onOpeningBalanceChange={onOpeningBalanceChange}
      />,
    );
    const input = screen.getByLabelText(/^saldo inicial$/i) as HTMLInputElement;
    expect(input.value).toBe('1000.00');
    fireEvent.change(input, { target: { value: '2500.50' } });
    expect(onOpeningBalanceChange).toHaveBeenCalledWith('2500.50');
  });

  it('shows the raw draft while typing a mid-decimal value (no snapping)', () => {
    const onOpeningBalanceChange = vi.fn<(value: string | undefined) => void>();
    renderWithProviders(
      <LeverPanel
        levers={[]}
        onChange={vi.fn()}
        anchorCash={1000}
        onOpeningBalanceChange={onOpeningBalanceChange}
      />,
    );
    const input = screen.getByLabelText(/^saldo inicial$/i) as HTMLInputElement;
    // A decimal point in progress must NOT be reformatted to "2500.00" in the
    // field — the user is still typing the fractional part.
    fireEvent.change(input, { target: { value: '2500.' } });
    expect(input.value).toBe('2500.');
    fireEvent.change(input, { target: { value: '2500.5' } });
    expect(input.value).toBe('2500.5');
  });

  it('commits the 2dp value on blur', () => {
    const onOpeningBalanceChange = vi.fn<(value: string | undefined) => void>();
    renderWithProviders(
      <LeverPanel
        levers={[]}
        onChange={vi.fn()}
        anchorCash={1000}
        onOpeningBalanceChange={onOpeningBalanceChange}
      />,
    );
    const input = screen.getByLabelText(/^saldo inicial$/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2500.5' } });
    fireEvent.blur(input, { target: { value: '2500.5' } });
    expect(onOpeningBalanceChange).toHaveBeenLastCalledWith('2500.50');
  });

  it('commits a negative opening balance (real cash can be negative)', () => {
    const onOpeningBalanceChange = vi.fn<(value: string | undefined) => void>();
    renderWithProviders(
      <LeverPanel
        levers={[]}
        onChange={vi.fn()}
        anchorCash={1000}
        onOpeningBalanceChange={onOpeningBalanceChange}
      />,
    );
    const input = screen.getByLabelText(/^saldo inicial$/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-100.00' } });
    expect(input.value).toBe('-100.00');
    expect(onOpeningBalanceChange).toHaveBeenLastCalledWith('-100.00');
  });

  it('clears to an empty field and commits undefined (falls back to anchor)', () => {
    const onOpeningBalanceChange = vi.fn<(value: string | undefined) => void>();
    renderWithProviders(
      <LeverPanel
        levers={[]}
        onChange={vi.fn()}
        anchorCash={1000}
        openingBalanceOverride="2500.50"
        onOpeningBalanceChange={onOpeningBalanceChange}
      />,
    );
    const input = screen.getByLabelText(/^saldo inicial$/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    // The field stays empty so the user can retype — it does NOT snap back.
    expect(input.value).toBe('');
    expect(onOpeningBalanceChange).toHaveBeenLastCalledWith(undefined);
  });

  it('clears the override when the reset affordance is used', () => {
    const onOpeningBalanceChange = vi.fn<(value: string | undefined) => void>();
    renderWithProviders(
      <LeverPanel
        levers={[]}
        onChange={vi.fn()}
        anchorCash={1000}
        openingBalanceOverride="2500.50"
        onOpeningBalanceChange={onOpeningBalanceChange}
      />,
    );
    const input = screen.getByLabelText(/^saldo inicial$/i) as HTMLInputElement;
    fireEvent.click(screen.getByLabelText(/redefinir saldo inicial/i));
    expect(onOpeningBalanceChange).toHaveBeenCalledWith(undefined);
    // The reset re-seeds the draft to the anchor display.
    expect(input.value).toBe('1000.00');
  });
});
