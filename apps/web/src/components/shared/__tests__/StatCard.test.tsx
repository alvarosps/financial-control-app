import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatCard } from '@/components/shared/StatCard';

describe('StatCard', () => {
  it('renders label and value', () => {
    const { getByText } = render(<StatCard label="Renda" value="R$ 18.900" />);
    expect(getByText('Renda')).toBeInTheDocument();
    expect(getByText('R$ 18.900')).toBeInTheDocument();
  });
  it('colors the value by tone', () => {
    const { getByText } = render(<StatCard label="X" value="R$ 1" tone="income" />);
    expect(getByText('R$ 1').className).toContain('text-income');
  });
  it('value uses the numeric font', () => {
    const { getByText } = render(<StatCard label="Saldo" value="R$ 10,00" />);
    expect(getByText('R$ 10,00').className).toContain('font-numeric');
  });
  it('renders an icon chip tinted by tone', () => {
    const { container } = render(
      <StatCard label="X" value="1" tone="expense" icon={<svg data-testid="i" />} />,
    );
    const chip = container.querySelector('svg')?.parentElement as HTMLElement;
    expect(chip.className).toContain('bg-expense/15');
  });
  it('renders a delta colored by direction', () => {
    const { getByText } = render(
      <StatCard label="X" value="1" delta={{ label: '+8%', direction: 'up' }} />,
    );
    expect(getByText('+8%').className).toContain('text-income');
  });
  it('forwards the glass surface to the card', () => {
    const { container } = render(<StatCard label="X" value="1" surface="glass" />);
    expect((container.firstChild as HTMLElement).className).toContain('glass');
  });
});
