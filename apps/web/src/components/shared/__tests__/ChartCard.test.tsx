import { render } from '@testing-library/react';
import { Bar, BarChart } from 'recharts';
import { describe, expect, it } from 'vitest';
import { ChartCard } from '@/components/shared/ChartCard';
import type { ChartConfig } from '@/components/ui/chart';

const config = {
  revenue: { label: 'Revenue', color: 'oklch(0.7 0.2 150)' },
} satisfies ChartConfig;

const chart = (
  <BarChart data={[{ month: 'Jan', revenue: 10 }]}>
    <Bar dataKey="revenue" fill="var(--color-revenue)" />
  </BarChart>
);

describe('ChartCard', () => {
  it('renders the title', () => {
    const { getByText } = render(
      <ChartCard title="Receita mensal" config={config}>
        {chart}
      </ChartCard>,
    );
    expect(getByText('Receita mensal')).toBeInTheDocument();
  });

  it('renders the description when provided', () => {
    const { getByText } = render(
      <ChartCard title="Receita mensal" description="Últimos 12 meses" config={config}>
        {chart}
      </ChartCard>,
    );
    expect(getByText('Últimos 12 meses')).toBeInTheDocument();
  });

  it('omits the description when not provided', () => {
    const { container } = render(
      <ChartCard title="Receita mensal" config={config}>
        {chart}
      </ChartCard>,
    );
    expect(container.querySelector('[data-slot="card-description"]')).toBeNull();
  });

  it('renders the chart container with a data-chart slot', () => {
    const { container } = render(
      <ChartCard title="Receita mensal" config={config}>
        {chart}
      </ChartCard>,
    );
    expect(container.querySelector('[data-slot="chart"]')).toBeInTheDocument();
  });

  it('injects a --color-<key> CSS variable from the config via ChartStyle', () => {
    const { container } = render(
      <ChartCard title="Receita mensal" config={config}>
        {chart}
      </ChartCard>,
    );
    const style = container.querySelector('style');
    expect(style?.innerHTML).toContain('--color-revenue: oklch(0.7 0.2 150);');
  });

  it('forwards the glass surface to the underlying card', () => {
    const { container } = render(
      <ChartCard title="Receita mensal" config={config} surface="glass">
        {chart}
      </ChartCard>,
    );
    expect((container.firstChild as HTMLElement).className).toContain('glass');
  });
});
