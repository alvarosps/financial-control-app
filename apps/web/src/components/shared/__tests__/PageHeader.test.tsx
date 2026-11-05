import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '@/components/shared/PageHeader';

describe('PageHeader', () => {
  it('renders the title as a heading', () => {
    const { getByRole } = render(<PageHeader title="Cartões" />);
    expect(getByRole('heading', { name: 'Cartões' })).toBeInTheDocument();
  });
  it('renders subtitle and actions when provided', () => {
    const { getByText } = render(
      <PageHeader
        title="Cartões"
        subtitle="5 ativos"
        actions={<button type="button">Novo</button>}
      />,
    );
    expect(getByText('5 ativos')).toBeInTheDocument();
    expect(getByText('Novo')).toBeInTheDocument();
  });
  it('omits the actions container when no actions', () => {
    const { container } = render(<PageHeader title="X" />);
    expect(container.querySelectorAll('div').length).toBe(2); // wrapper + title col only
  });
});
