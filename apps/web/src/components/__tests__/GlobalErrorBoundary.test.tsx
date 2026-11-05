import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { GlobalErrorBoundary } from '../GlobalErrorBoundary';

function Kaboom(): never {
  throw new Error('boom');
}

describe('GlobalErrorBoundary', () => {
  it('renders fallback UI when a child throws', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderWithProviders(
      <GlobalErrorBoundary>
        <Kaboom />
      </GlobalErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/boom/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tentar novamente|try again/i })).toBeInTheDocument();
    err.mockRestore();
  });

  it('reset button remounts children', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Maybe() {
      if (shouldThrow) throw new Error('boom');
      return <p>ok</p>;
    }
    const user = userEvent.setup();
    renderWithProviders(
      <GlobalErrorBoundary>
        <Maybe />
      </GlobalErrorBoundary>,
    );
    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: /tentar novamente|try again/i }));
    expect(screen.getByText('ok')).toBeInTheDocument();
    err.mockRestore();
  });
});
