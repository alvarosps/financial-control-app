import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '@/components/shared/EmptyState';

describe('EmptyState', () => {
  it('renders title, description and action', () => {
    const { getByText } = render(
      <EmptyState
        title="Nada aqui"
        description="Adicione o primeiro"
        action={<button type="button">Add</button>}
      />,
    );
    expect(getByText('Nada aqui')).toBeInTheDocument();
    expect(getByText('Adicione o primeiro')).toBeInTheDocument();
    expect(getByText('Add')).toBeInTheDocument();
  });
  it('wraps the icon in a rounded halo', () => {
    const { container } = render(<EmptyState title="X" icon={<svg data-testid="i" />} />);
    const halo = container.querySelector('svg')?.parentElement as HTMLElement;
    expect(halo.className).toContain('rounded-2xl');
    expect(halo.className).toContain('bg-muted/60');
  });
});
