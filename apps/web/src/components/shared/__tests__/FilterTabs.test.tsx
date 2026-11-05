import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilterTabs } from '@/components/shared/FilterTabs';

const tabs = [
  { key: 'all', label: 'Todos', count: 5 },
  { key: 'open', label: 'Abertas', count: 3 },
];

describe('FilterTabs', () => {
  it('renders tabs with counts and marks the active one', () => {
    const { getByRole } = render(<FilterTabs tabs={tabs} value="all" onValueChange={() => {}} />);
    const all = getByRole('tab', { name: /Todos/ });
    const open = getByRole('tab', { name: /Abertas/ });
    expect(all.getAttribute('aria-selected')).toBe('true');
    expect(open.getAttribute('aria-selected')).toBe('false');
    expect(all.textContent).toContain('(5)');
  });
  it('calls onValueChange with the clicked tab key', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<FilterTabs tabs={tabs} value="all" onValueChange={onChange} />);
    fireEvent.click(getByRole('tab', { name: /Abertas/ }));
    expect(onChange).toHaveBeenCalledWith('open');
  });
  it('exposes a tablist', () => {
    const { getByRole } = render(<FilterTabs tabs={tabs} value="all" onValueChange={() => {}} />);
    expect(getByRole('tablist')).toBeInTheDocument();
  });
});
