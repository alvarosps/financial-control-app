import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PayoffMeter } from '@/components/shared/PayoffMeter';

describe('PayoffMeter', () => {
  it('renders label and amount in the income token', () => {
    const { getByText } = render(<PayoffMeter label="Quitação" amount="R$ 38.400" />);
    expect(getByText('Quitação').className).toContain('text-income');
    expect(getByText('R$ 38.400').className).toContain('text-income');
  });
  it('renders savings only when provided', () => {
    const { queryByText, rerender, getByText } = render(<PayoffMeter label="Q" amount="R$ 1" />);
    expect(queryByText('12%')).toBeNull();
    rerender(<PayoffMeter label="Q" amount="R$ 1" savingsLabel="Economia" savingsValue="12%" />);
    expect(getByText('Economia')).toBeInTheDocument();
    expect(getByText('12%')).toBeInTheDocument();
  });
  it('uses the income border tint', () => {
    const { container } = render(<PayoffMeter label="Q" amount="R$ 1" />);
    expect((container.firstChild as HTMLElement).className).toContain('border-income/25');
  });
});
