import { act, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '@/lib/providers/ThemeProvider';
import { renderWithProviders } from '@/test/render';
import { ThemeToggle } from '../theme-toggle';

function renderThemeToggle() {
  return renderWithProviders(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe('ThemeToggle', () => {
  it('renders the light, dark and system options once mounted', async () => {
    const { findByRole } = renderThemeToggle();

    expect(await findByRole('group', { name: 'Alternar tema' })).toBeInTheDocument();
    expect(await findByRole('button', { name: 'Selecionar tema Claro' })).toBeInTheDocument();
    expect(await findByRole('button', { name: 'Selecionar tema Escuro' })).toBeInTheDocument();
    expect(await findByRole('button', { name: 'Selecionar tema Sistema' })).toBeInTheDocument();
  });

  it('marks the active theme option with aria-pressed', async () => {
    const { findByRole } = renderThemeToggle();
    const systemButton = await findByRole('button', { name: 'Selecionar tema Sistema' });

    expect(systemButton.getAttribute('aria-pressed')).toBe('true');

    const darkButton = await findByRole('button', { name: 'Selecionar tema Escuro' });
    await act(async () => {
      fireEvent.click(darkButton);
    });

    expect(darkButton.getAttribute('aria-pressed')).toBe('true');
  });
});
