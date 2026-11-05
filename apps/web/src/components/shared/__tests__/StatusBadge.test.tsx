import { describe, expect, it } from 'vitest';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { renderWithProviders } from '@/test/render';

describe('StatusBadge token mapping', () => {
  it('paid → income token (no hardcoded emerald) and renders "Pago"', () => {
    const { container, getByText } = renderWithProviders(<StatusBadge status="paid" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('text-income');
    expect(el.className).toContain('bg-income/15');
    expect(el.className).not.toMatch(/emerald/);
    expect(getByText('Pago')).toBeInTheDocument();
  });

  it('pending → warning token and renders "Pendente"', () => {
    const { container, getByText } = renderWithProviders(<StatusBadge status="pending" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('text-warning');
    expect(el.className).not.toMatch(/yellow/);
    expect(getByText('Pendente')).toBeInTheDocument();
  });

  it('overdue → expense token and renders "Atrasado"', () => {
    const { container, getByText } = renderWithProviders(<StatusBadge status="overdue" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('text-expense');
    expect(el.className).not.toMatch(/text-red-/);
    expect(getByText('Atrasado')).toBeInTheDocument();
  });
});
