import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CreditCardVisual } from '@/components/shared/CreditCardVisual';

describe('CreditCardVisual', () => {
  it('applies the per-entity color via the --card-color CSS variable', () => {
    const { container } = render(<CreditCardVisual name="Itaú" color="oklch(0.62 0.21 285)" />);
    const el = container.querySelector('[data-slot="credit-card-visual"]') as HTMLElement;
    expect(el.style.getPropertyValue('--card-color')).toBe('oklch(0.62 0.21 285)');
    expect(el.className).toContain('var(--card-color)');
  });
  it('falls back to the brand gradient when no color', () => {
    const { container } = render(<CreditCardVisual name="X" />);
    const el = container.querySelector('[data-slot="credit-card-visual"]') as HTMLElement;
    expect(el.className).toContain('gradient-brand');
    expect(el.style.getPropertyValue('--card-color')).toBe('');
  });
  it('renders name, last4, dueDay (with label), bill and status', () => {
    const { getByText, container } = render(
      <CreditCardVisual
        name="Nubank"
        last4="1077"
        dueDay={2}
        dueLabel="venc."
        bill={<span>R$ 1.980</span>}
        status={<span>Aberta</span>}
      />,
    );
    expect(getByText('Nubank')).toBeInTheDocument();
    expect(getByText(/1077/)).toBeInTheDocument();
    expect(getByText('R$ 1.980')).toBeInTheDocument();
    expect(getByText('Aberta')).toBeInTheDocument();
    const dueEl = container.querySelector('[data-slot="cc-due-day"]')?.textContent;
    expect(dueEl).toContain('venc.');
    expect(dueEl).toContain('2');
  });
  it('renders the bill month label and the limit bar when provided', () => {
    render(
      <CreditCardVisual
        name="Nubank"
        billMonthLabel="Fatura: Junho 2026"
        limitPct={38}
        limitLabel="limite"
      />,
    );
    expect(screen.getByText('Fatura: Junho 2026')).toBeInTheDocument();
    expect(screen.getByText('38% limite')).toBeInTheDocument();
    expect(screen.getByTestId('cc-limit-bar')).toBeInTheDocument();
  });

  it('omits the limit bar when limitPct is undefined', () => {
    render(<CreditCardVisual name="Nubank" />);
    expect(screen.queryByTestId('cc-limit-bar')).not.toBeInTheDocument();
  });
});
