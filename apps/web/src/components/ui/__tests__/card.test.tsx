import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card } from '@/components/ui/card';

describe('Card surface variant', () => {
  it('defaults to the solid surface (bg-card + ring)', () => {
    const { container } = render(<Card>content</Card>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('bg-card');
    expect(el.className).toContain('ring-1');
    expect(el.className).not.toContain('glass');
    expect(el.getAttribute('data-slot')).toBe('card');
  });

  it('surface="solid" is explicit solid', () => {
    const { container } = render(<Card surface="solid">x</Card>);
    expect((container.firstChild as HTMLElement).className).toContain('bg-card');
  });

  it('surface="glass" uses the glass utility and drops the solid bg/ring', () => {
    const { container } = render(<Card surface="glass">x</Card>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('glass');
    expect(el.className).not.toContain('bg-card');
    expect(el.className).not.toContain('ring-1');
  });

  it('keeps layout classes regardless of surface', () => {
    const { container } = render(<Card surface="glass">x</Card>);
    expect((container.firstChild as HTMLElement).className).toContain('rounded-xl');
  });
});
