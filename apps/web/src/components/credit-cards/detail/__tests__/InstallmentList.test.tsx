import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { InstallmentList } from '../InstallmentList';

type Installment = Parameters<typeof InstallmentList>[0]['items'][number];

function makeInstallment(overrides: Partial<Installment> = {}): Installment {
  return {
    id: 'inst-1',
    description: 'Geladeira',
    amount: '250.00',
    totalOccurrences: 12,
    startingOccurrence: 3,
    categoryId: null,
    canEdit: true,
    ...overrides,
  };
}

describe('InstallmentList', () => {
  it('renders an empty-state message when no installments are provided', () => {
    renderWithProviders(
      <InstallmentList items={[]} categories={[]} onEdit={() => {}} onDelete={() => {}} />,
    );
    expect(screen.getByText(/nenhuma parcela encontrada/i)).toBeInTheDocument();
  });

  it('preserves row identity (stable keys) across prop reorders', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const items = [
      makeInstallment({ id: 'a', description: 'Alpha', startingOccurrence: 1 }),
      makeInstallment({ id: 'b', description: 'Bravo', startingOccurrence: 2 }),
      makeInstallment({ id: 'c', description: 'Charlie', startingOccurrence: 3 }),
    ];

    const { rerender } = renderWithProviders(
      <InstallmentList items={items} categories={[]} onEdit={onEdit} onDelete={onDelete} />,
    );

    // Grab the first "Alpha" row element identity before reorder.
    const alphaBefore = screen.getByText('Alpha');

    // Rerender with a shuffled input array — same ids, different order.
    const reordered = [items[2], items[0], items[1]];
    rerender(
      <InstallmentList items={reordered} categories={[]} onEdit={onEdit} onDelete={onDelete} />,
    );

    // The DOM node rendering "Alpha" must be the *same* element instance
    // if React reused the row via its stable `id` key.
    const alphaAfter = screen.getByText('Alpha');
    expect(alphaAfter).toBe(alphaBefore);
  });
});
