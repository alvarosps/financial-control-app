import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { QuickSummary } from '../QuickSummary';

describe('QuickSummary', () => {
  const base = {
    closingDay: 15,
    dueDay: 25,
    dueDate: '2026-04-25',
    creditLimit: '5000.00',
    currentBillTotal: 1200,
    totalUsed: 2500,
    previousBillTotal: 900,
    currentBillMonth: 4,
    currentBillYear: 2026,
  };

  it('labels estimated due dates and the separate competence period', () => {
    renderWithProviders(
      <QuickSummary {...base} dueDate="2026-05-08" dueDateSource="configuration" />,
    );
    expect(screen.getByText(/Estimativa/)).toBeInTheDocument();
    expect(screen.getByText(/Competência: abr.*2026/)).toBeInTheDocument();
  });

  it('renders utilization percent when a credit limit is set', () => {
    renderWithProviders(<QuickSummary {...base} />);
    // totalUsed 2500 / limit 5000 = 50% (ProgressMeter rounds to an integer)
    expect(screen.getByText(/50%/)).toBeInTheDocument();
  });

  it('shows a limit-not-configured message when creditLimit is null', () => {
    renderWithProviders(<QuickSummary {...base} creditLimit={null} />);
    expect(screen.getByText(/limite n[aã]o configurado/i)).toBeInTheDocument();
    // Percent badge should NOT render.
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('omits the previous-bill delta when previousBillTotal is null', () => {
    const { rerender } = renderWithProviders(<QuickSummary {...base} previousBillTotal={900} />);
    // Baseline: the current-bill StatCard shows a delta referencing the previous bill.
    expect(screen.getByText(/fatura anterior/i)).toBeInTheDocument();
    rerender(<QuickSummary {...base} previousBillTotal={null} />);
    expect(screen.queryByText(/fatura anterior/i)).not.toBeInTheDocument();
  });

  it('displays the real due date from dueDate when provided', () => {
    // closingDay=20, dueDay=5 → dueDate is in the NEXT month (July 2026)
    renderWithProviders(
      <QuickSummary
        {...base}
        closingDay={20}
        dueDay={5}
        dueDate="2026-07-05"
        currentBillMonth={6}
        currentBillYear={2026}
      />,
    );
    // Should show the exact July due date, not only any July date in the summary.
    expect(screen.getByText('05 de jul. de 2026')).toBeInTheDocument();
  });

  it('shows an unknown due date without inventing a day', () => {
    renderWithProviders(
      <QuickSummary
        {...base}
        dueDate={null}
        dueDay={25}
        currentBillMonth={4}
        currentBillYear={2026}
      />,
    );
    expect(screen.getByText('Data não informada')).toBeInTheDocument();
  });
});
