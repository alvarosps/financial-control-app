import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AmountDisplay } from '@/components/shared/AmountDisplay';

describe('AmountDisplay token mapping', () => {
  it('income variant uses the income token, not hardcoded emerald', () => {
    const { container } = render(<AmountDisplay amount={1200} variant="income" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('text-income');
    expect(el.className).not.toMatch(/emerald/);
  });

  it('expense variant uses the expense token, not hardcoded red', () => {
    const { container } = render(<AmountDisplay amount={50} variant="expense" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('text-expense');
    expect(el.className).not.toMatch(/text-red-/);
  });

  it('no variant: positive amount → income, negative → expense', () => {
    const pos = render(<AmountDisplay amount={10} />).container.firstChild as HTMLElement;
    const neg = render(<AmountDisplay amount={-10} />).container.firstChild as HTMLElement;
    expect(pos.className).toContain('text-income');
    expect(neg.className).toContain('text-expense');
  });

  it('neutral variant uses foreground', () => {
    const { container } = render(<AmountDisplay amount={10} variant="neutral" />);
    expect((container.firstChild as HTMLElement).className).toContain('text-foreground');
  });

  it('formats BRL with tabular-nums', () => {
    const { container } = render(<AmountDisplay amount={1234.5} />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('tabular-nums');
    expect(el.textContent).toContain('R$');
  });

  it('renders monetary values with the numeric font', () => {
    const { container } = render(<AmountDisplay amount={10} />);
    expect((container.firstChild as HTMLElement).className).toContain('font-numeric');
  });
});
