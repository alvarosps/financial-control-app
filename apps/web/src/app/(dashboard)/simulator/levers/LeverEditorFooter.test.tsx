/**
 * LeverEditorFooter test (Task 10).
 *
 * Pure presentational footer (no tRPC), rendered under the NextIntl provider
 * via `renderWithProviders` (pt-BR messages). Asserts the add/save label
 * toggles on `existing` and that the submit button is disabled when
 * `canSubmit` is false.
 */
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { LeverEditorFooter } from './LeverEditorFooter';

describe('LeverEditorFooter', () => {
  it('shows the add label when creating a new lever', () => {
    renderWithProviders(
      <LeverEditorFooter existing={false} canSubmit onCancel={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /salvar/i })).not.toBeInTheDocument();
  });

  it('shows the save label when editing an existing lever', () => {
    renderWithProviders(
      <LeverEditorFooter existing canSubmit onCancel={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /salvar/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /adicionar/i })).not.toBeInTheDocument();
  });

  it('disables submit when canSubmit is false', () => {
    const onSubmit = vi.fn();
    renderWithProviders(
      <LeverEditorFooter
        existing={false}
        canSubmit={false}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByRole('button', { name: /adicionar/i })).toBeDisabled();
  });

  it('invokes onCancel and onSubmit on click', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    renderWithProviders(
      <LeverEditorFooter existing={false} canSubmit onCancel={onCancel} onSubmit={onSubmit} />,
    );

    await user.click(screen.getByRole('button', { name: /cancelar/i }));
    await user.click(screen.getByRole('button', { name: /adicionar/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
