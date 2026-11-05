import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Progress } from '@/components/ui/progress';

describe('Progress', () => {
  it('renders a progressbar with correct ARIA', () => {
    const { container } = render(<Progress value={63} aria-label="Pagamento" />);
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute('aria-valuenow')).toBe('63');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-label')).toBe('Pagamento');
  });

  it('fill width reflects the percentage and defaults to the brand gradient', () => {
    const { container } = render(<Progress value={63} />);
    const fill = container.querySelector('[data-slot="progress-fill"]') as HTMLElement;
    expect(fill.style.width).toBe('63%');
    expect(fill.className).toContain('gradient-brand');
  });

  it('supports a semantic tone', () => {
    const { container } = render(<Progress value={80} tone="income" />);
    const fill = container.querySelector('[data-slot="progress-fill"]') as HTMLElement;
    expect(fill.className).toContain('bg-income');
  });

  it('clamps out-of-range values to 0..100', () => {
    const over = render(<Progress value={150} />).container.querySelector(
      '[data-slot="progress-fill"]',
    ) as HTMLElement;
    const under = render(<Progress value={-10} />).container.querySelector(
      '[data-slot="progress-fill"]',
    ) as HTMLElement;
    expect(over.style.width).toBe('100%');
    expect(under.style.width).toBe('0%');
  });

  it('computes percentage from value/max', () => {
    const { container } = render(<Progress value={3} max={12} />);
    const fill = container.querySelector('[data-slot="progress-fill"]') as HTMLElement;
    expect(fill.style.width).toBe('25%');
  });

  it('exposes a percentage aria-valuetext by default', () => {
    const { container } = render(<Progress value={3} max={12} />);
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute('aria-valuetext')).toBe('25%');
  });
});
