import { fireEvent } from '@testing-library/react';
import { ShoppingCart } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import {
  CollapsibleSpendingSection,
  SPENDING_TONES,
  type SpendingTone,
} from '@/components/monthly-spending/CollapsibleSpendingSection';
import { renderWithProviders, screen } from '@/test/render';

describe('CollapsibleSpendingSection', () => {
  it('renders title, formatted total and children when open', () => {
    renderWithProviders(
      <CollapsibleSpendingSection tone="grocery" icon={ShoppingCart} title="Mercado" total={1234.5}>
        <div>child-content</div>
      </CollapsibleSpendingSection>,
    );

    expect(screen.getByText('Mercado')).toBeInTheDocument();
    expect(screen.getByText(/1\.234,50/)).toBeInTheDocument();
    expect(screen.getByText('child-content')).toBeInTheDocument();
  });

  it('toggles children on header click and reflects aria-expanded', () => {
    renderWithProviders(
      <CollapsibleSpendingSection tone="loans" icon={ShoppingCart} title="Empréstimos" total={10}>
        <div>child-content</div>
      </CollapsibleSpendingSection>,
    );

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('child-content')).not.toBeInTheDocument();
  });

  it('applies the tone text class to the total', () => {
    renderWithProviders(
      <CollapsibleSpendingSection tone="grocery" icon={ShoppingCart} title="Mercado" total={99}>
        <span />
      </CollapsibleSpendingSection>,
    );

    const total = screen.getByText(/99,00/);
    expect(total.className).toContain('text-spend-grocery');
    expect(total.className).toContain('font-numeric');
  });

  it('maps every tone only to semantic token classes', () => {
    const tones = Object.keys(SPENDING_TONES) as SpendingTone[];
    expect(tones).toHaveLength(8);

    for (const tone of tones) {
      const classes = SPENDING_TONES[tone];
      expect(classes.text).toMatch(
        /^text-(expense|warning|info|spend-(grocery|store|marketplace|vehicle|other))$/,
      );

      for (const className of [
        classes.container,
        classes.headerHover,
        classes.itemBorder,
        classes.itemHover,
      ]) {
        expect(className).not.toMatch(/#|blue-|red-|green-|orange-|pink-|cyan-|purple-|yellow-/);
      }
    }
  });
});
