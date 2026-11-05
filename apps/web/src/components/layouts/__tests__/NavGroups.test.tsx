import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NavGroups } from '@/components/layouts/NavGroups';
import { renderWithProviders } from '@/test/render';

vi.mock('next/navigation', () => ({ usePathname: () => '/credit-cards' }));

describe('NavGroups', () => {
  it('renders all four group labels', () => {
    const { getByText } = renderWithProviders(<NavGroups />);
    // pt-BR group labels (renderWithProviders uses pt-BR messages)
    expect(getByText('Visão geral')).toBeInTheDocument();
    expect(getByText('Contas & cartões')).toBeInTheDocument();
    expect(getByText('Crédito & renda')).toBeInTheDocument();
    expect(getByText('Sistema')).toBeInTheDocument();
  });

  it('marks the active route with aria-current and the brand gradient', () => {
    const { getByRole } = renderWithProviders(<NavGroups />);
    const active = getByRole('link', { current: 'page' });
    expect(active.getAttribute('href')).toBe('/credit-cards');
    expect(active.className).toContain('gradient-brand');
  });

  it('calls onNavigate when a link is clicked', () => {
    const onNavigate = vi.fn();
    const { getByRole } = renderWithProviders(<NavGroups onNavigate={onNavigate} />);
    const activeLink = getByRole('link', { current: 'page' });
    activeLink.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(activeLink);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('renders the Simulator link in the overview group', () => {
    const { getByRole } = renderWithProviders(<NavGroups />);
    const link = getByRole('link', { name: 'Simulador' });
    expect(link.getAttribute('href')).toBe('/simulator');
  });
});
