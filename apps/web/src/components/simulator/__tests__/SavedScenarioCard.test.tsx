import type { SimScenario } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { SavedScenarioCard, type SavedScenarioRow } from '../SavedScenarioCard';

const SCENARIO: SimScenario = {
  name: 'Quitar Itaú',
  horizon: 12,
  levers: [
    {
      kind: 'loan_payoff',
      id: 'l1',
      loanAccountId: 'acc-1',
      targetMonth: { month: 8, year: 2026 },
    },
  ],
};

const ROW: SavedScenarioRow = {
  id: 'scn-1',
  name: 'Quitar Itaú',
  createdAt: '2026-06-10T12:00:00.000Z',
  scenario: SCENARIO,
  ending: 1800,
};

describe('SavedScenarioCard', () => {
  it('renders the name, the created date and the simulated-ending KPI', () => {
    renderWithProviders(
      <SavedScenarioCard
        row={ROW}
        onRerun={() => {}}
        onDuplicate={() => {}}
        onCompareToggle={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText('Quitar Itaú')).toBeTruthy();
    expect(screen.getByText('10/06/2026')).toBeTruthy();
    expect(screen.getByText('R$ 1.800,00')).toBeTruthy();
  });

  it('omits the ending row and any sparkline when no summary is available', () => {
    const { container } = renderWithProviders(
      <SavedScenarioCard
        row={{
          id: 'scn-2',
          name: 'Sem resumo',
          createdAt: '2026-06-10T12:00:00.000Z',
          scenario: SCENARIO,
        }}
        onRerun={() => {}}
        onDuplicate={() => {}}
        onCompareToggle={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByText('R$ 1.800,00')).toBeNull();
    // The dead snapshot sparkline path is removed: no inline SVG renders.
    expect(container.querySelector('svg polyline')).toBeNull();
  });

  it('renders a negative ending with the expense tone (not forced green)', () => {
    const { container } = renderWithProviders(
      <SavedScenarioCard
        row={{ ...ROW, ending: -1800 }}
        onRerun={() => {}}
        onDuplicate={() => {}}
        onCompareToggle={() => {}}
        onDelete={() => {}}
      />,
    );
    const amount = container.querySelector('span.text-expense');
    expect(amount).not.toBeNull();
    expect(amount?.textContent).toBe('-R$ 1.800,00');
    expect(container.querySelector('span.text-income')).toBeNull();
  });

  it('disables the Duplicate button while a duplication is pending', () => {
    renderWithProviders(
      <SavedScenarioCard
        row={ROW}
        duplicateDisabled
        onRerun={() => {}}
        onDuplicate={() => {}}
        onCompareToggle={() => {}}
        onDelete={() => {}}
      />,
    );
    const duplicate = screen.getByRole('button', { name: /duplicar|duplicate/i });
    expect(duplicate).toBeDisabled();
  });

  it('fires each action callback', async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();
    const onDuplicate = vi.fn();
    const onCompareToggle = vi.fn();
    const onDelete = vi.fn();
    renderWithProviders(
      <SavedScenarioCard
        row={ROW}
        onRerun={onRerun}
        onDuplicate={onDuplicate}
        onCompareToggle={onCompareToggle}
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByRole('button', { name: /reexecutar|re-run/i }));
    await user.click(screen.getByRole('button', { name: /duplicar|duplicate/i }));
    await user.click(screen.getByRole('checkbox', { name: /comparar|compare/i }));
    await user.click(screen.getByRole('button', { name: /remover|delete/i }));

    expect(onRerun).toHaveBeenCalledWith(ROW);
    expect(onDuplicate).toHaveBeenCalledWith(ROW);
    expect(onCompareToggle).toHaveBeenCalledWith(ROW);
    expect(onDelete).toHaveBeenCalledWith(ROW);
  });
});
