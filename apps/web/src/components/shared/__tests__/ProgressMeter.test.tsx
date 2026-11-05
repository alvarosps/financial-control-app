import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressMeter } from '@/components/shared/ProgressMeter';

function fill(container: HTMLElement) {
  return container.querySelector('[data-slot="progress-fill"]') as HTMLElement;
}

describe('ProgressMeter', () => {
  it('shows current/total and percentage', () => {
    const { getByText } = render(<ProgressMeter current={38} total={60} />);
    expect(getByText('38/60')).toBeInTheDocument();
    expect(getByText('63%')).toBeInTheDocument();
  });
  it('derives income tone at >=75%', () => {
    const { container } = render(<ProgressMeter current={80} total={100} />);
    expect(fill(container).className).toContain('bg-income');
  });
  it('derives info tone at >=25%', () => {
    const { container } = render(<ProgressMeter current={50} total={100} />);
    expect(fill(container).className).toContain('bg-info');
  });
  it('derives brand tone below 25%', () => {
    const { container } = render(<ProgressMeter current={10} total={100} />);
    expect(fill(container).className).toContain('gradient-brand');
  });
  it('respects an explicit tone and custom label', () => {
    const { container, getByText } = render(
      <ProgressMeter current={10} total={100} tone="warning" label="Parcela 1/10" />,
    );
    expect(getByText('Parcela 1/10')).toBeInTheDocument();
    expect(fill(container).className).toContain('bg-warning');
  });
});
