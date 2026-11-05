import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, within } from '@/test/render';
import { MonthlyPaymentSummary } from '../MonthlyPaymentSummary';
import { PaymentListSection } from '../PaymentListSection';

type LedgerFixture = ComponentProps<typeof PaymentListSection>['ledger'];

const ledger = {
  months: [
    {
      monthKey: '2026-06',
      owed: 1000,
      paid: 500,
      remaining: 500,
      status: 'overdue',
      borrowedCardTotal: 0,
    },
    {
      monthKey: '2026-07',
      owed: 2000,
      paid: 300,
      remaining: 1700,
      status: 'partially_paid',
      borrowedCardTotal: 0,
    },
  ],
  totals: {
    totalOutstanding: 2200,
    totalOverdue: 500,
    totalOwed: 3000,
    totalPaid: 800,
    creditBalance: 0,
  },
  payments: [
    {
      id: 'p1',
      date: new Date('2026-07-05T00:00:00.000Z'),
      amount: '200.00',
      description: 'PIX',
      walletAccountId: 'wallet-1',
      cashAmount: null,
      settlementSource: 'legacy',
      settlementDate: null,
    },
    {
      id: 'p2',
      date: new Date('2026-07-20T00:00:00.000Z'),
      amount: '100.00',
      description: 'Dinheiro',
      walletAccountId: 'wallet-1',
      cashAmount: null,
      settlementSource: 'legacy',
      settlementDate: null,
    },
    {
      id: 'p3',
      date: new Date('2026-06-30T00:00:00.000Z'),
      amount: '500.00',
      description: 'Junho',
      walletAccountId: 'wallet-1',
      cashAmount: null,
      settlementSource: 'legacy',
      settlementDate: null,
    },
  ],
} satisfies LedgerFixture;

function renderSummary(currentLedger: LedgerFixture = ledger) {
  return renderWithProviders(
    <MonthlyPaymentSummary ledger={currentLedger} month={7} year={2026} />,
  );
}

describe('MonthlyPaymentSummary', () => {
  it('separates current-month cash flow from debt allocation', () => {
    renderSummary();
    const summary = screen.getByRole('complementary', { name: 'Resumo do mês' });

    expect(within(summary).getByText('R$ 1.700,00')).toBeInTheDocument();
    expect(within(summary).getByText('R$ 300,00')).toBeInTheDocument();
    expect(within(summary).getByText('05/07/2026')).toBeInTheDocument();
    expect(within(summary).getByText('20/07/2026')).toBeInTheDocument();
    expect(within(summary).queryByText('30/06/2026')).not.toBeInTheDocument();
    expect(within(summary).getAllByText('R$ 500,00').length).toBeGreaterThan(0);
    expect(within(summary).getByText(/junho 2026/i)).toBeInTheDocument();
  });

  it('renders zero and positive empty states', () => {
    renderSummary({
      months: [],
      totals: {
        totalOutstanding: 0,
        totalOverdue: 0,
        totalOwed: 0,
        totalPaid: 0,
        creditBalance: 0,
      },
      payments: [],
    });

    expect(screen.getByText('Sem valores atrasados')).toBeInTheDocument();
    expect(screen.getByText('Nenhum pagamento feito neste mês')).toBeInTheDocument();
    expect(screen.getAllByText('R$ 0,00').length).toBeGreaterThanOrEqual(2);
  });

  it('sums decimal payment values with Money', () => {
    renderSummary({
      ...ledger,
      payments: [
        { ...ledger.payments[0], id: 'a', amount: '100.10' },
        { ...ledger.payments[1], id: 'b', amount: '0.20' },
      ],
    });

    const summary = screen.getByRole('complementary', { name: 'Resumo do mês' });
    expect(within(summary).getByText('R$ 100,30')).toBeInTheDocument();
  });
});

describe('PaymentListSection', () => {
  it('keeps the full payment ledger without the monthly summary', () => {
    renderWithProviders(
      <PaymentListSection ledger={ledger} onReversePayment={vi.fn()} isReversing={false} />,
    );

    expect(screen.queryByRole('complementary', { name: 'Resumo do mês' })).not.toBeInTheDocument();
    expect(screen.getByText('30/06/2026')).toBeInTheDocument();
  });
});
