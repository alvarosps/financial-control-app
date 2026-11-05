import { describe, expect, it } from 'vitest';
import { CHART_ANIMATION, referenceBandProps, ZERO_LINE } from '@/lib/chart-conventions';

describe('chart conventions', () => {
  it('aligns the animation duration with --dur-base (220ms)', () => {
    expect(CHART_ANIMATION.animationDuration).toBe(220);
  });

  it('draws the zero line dashed in the expense color', () => {
    expect(ZERO_LINE).toEqual({ stroke: 'var(--color-expense)', strokeDasharray: '3 3' });
  });

  it('builds labelled reference-band props', () => {
    const props = referenceBandProps('Renda média');
    expect(props.strokeDasharray).toBe('6 4');
    expect(props.label.value).toBe('Renda média');
    expect(props.label.position).toBe('insideTopRight');
  });
});
