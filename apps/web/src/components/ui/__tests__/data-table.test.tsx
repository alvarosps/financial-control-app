import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type ColumnDef, DataTable } from '@/components/ui/data-table';

type Row = { name: string; amount: number };

const data: Row[] = [
  { name: 'Bravo', amount: 30 },
  { name: 'Alpha', amount: 10 },
  { name: 'Charlie', amount: 20 },
];

const columns: ColumnDef<Row>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'amount', header: 'Amount' },
];

function amountColumnOrder(container: HTMLElement): number[] {
  const bodyRows = within(container.querySelector('tbody') as HTMLElement).getAllByRole('row');
  return bodyRows.map((r) => Number(r.querySelectorAll('td')[1].textContent));
}

describe('DataTable', () => {
  it('renders a row per data item', () => {
    const { container } = render(<DataTable columns={columns} data={data} />);
    const bodyRows = within(container.querySelector('tbody') as HTMLElement).getAllByRole('row');
    expect(bodyRows).toHaveLength(3);
  });

  it('renders the cell values', () => {
    const { getByText } = render(<DataTable columns={columns} data={data} />);
    expect(getByText('Alpha')).toBeInTheDocument();
    expect(getByText('Bravo')).toBeInTheDocument();
    expect(getByText('Charlie')).toBeInTheDocument();
  });

  it('sorts by a numeric column when its header is clicked', () => {
    const { container, getByRole } = render(<DataTable columns={columns} data={data} />);
    // initial (unsorted) order follows the data array
    expect(amountColumnOrder(container)).toEqual([30, 10, 20]);

    // TanStack v8 sorts numeric columns descending-first.
    fireEvent.click(getByRole('button', { name: /Amount/ }));
    expect(amountColumnOrder(container)).toEqual([30, 20, 10]);
  });

  it('toggles the sort direction on a second click', () => {
    const { container, getByRole } = render(<DataTable columns={columns} data={data} />);
    const header = getByRole('button', { name: /Amount/ });
    fireEvent.click(header); // desc (numeric default)
    fireEvent.click(header); // asc
    expect(amountColumnOrder(container)).toEqual([10, 20, 30]);
  });

  it('shows the empty message when there is no data', () => {
    const { getByText } = render(
      <DataTable columns={columns} data={[]} emptyMessage="Nada por aqui" />,
    );
    expect(getByText('Nada por aqui')).toBeInTheDocument();
  });
});
