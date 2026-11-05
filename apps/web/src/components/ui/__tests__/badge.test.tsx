import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '@/components/ui/badge';

describe('Badge Aurora token variants', () => {
  it('income uses the income token, not hardcoded emerald', () => {
    const { container } = render(<Badge variant="income">i</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('text-income');
    expect(el.className).toContain('bg-income/15');
    expect(el.className).not.toMatch(/emerald/);
  });

  it('warning uses the warning token, not hardcoded amber', () => {
    const { container } = render(<Badge variant="warning">w</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('text-warning');
    expect(el.className).not.toMatch(/amber/);
  });

  it('adds brand / expense / info variants', () => {
    const brand = render(<Badge variant="brand">b</Badge>).container.firstChild as HTMLElement;
    const expense = render(<Badge variant="expense">e</Badge>).container.firstChild as HTMLElement;
    const info = render(<Badge variant="info">n</Badge>).container.firstChild as HTMLElement;
    expect(brand.className).toContain('text-primary');
    expect(brand.className).toContain('bg-primary/15');
    expect(expense.className).toContain('text-expense');
    expect(expense.className).toContain('bg-expense/15');
    expect(info.className).toContain('text-info');
    expect(info.className).toContain('bg-info/15');
  });

  it('still supports the existing default variant', () => {
    const { container } = render(<Badge>d</Badge>);
    expect((container.firstChild as HTMLElement).className).toContain('bg-primary');
  });
});
