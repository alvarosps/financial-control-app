import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';

describe('Button brand variant', () => {
  it('brand variant uses the gradient-brand utility', () => {
    const { container } = render(<Button variant="brand">Save</Button>);
    const el = container.querySelector('[data-slot="button"]') as HTMLElement;
    expect(el.className).toContain('gradient-brand');
    expect(el.className).toContain('text-white');
  });

  it('default variant is unchanged (solid primary)', () => {
    const { container } = render(<Button>Save</Button>);
    const el = container.querySelector('[data-slot="button"]') as HTMLElement;
    expect(el.className).toContain('bg-primary');
    expect(el.className).not.toContain('gradient-brand');
  });
});
