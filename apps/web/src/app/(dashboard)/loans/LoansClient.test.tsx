import { fireEvent, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { LoansClient } from './LoansClient';

function loanItem(
  id: string,
  name: string,
  category: 'bank' | 'personal',
  monthlyPayment: string,
  isPaidOff: boolean,
) {
  return {
    account: {
      id,
      userId: 'user-1',
      name,
      type: 'loan',
      currency: 'BRL',
      currentBalance: '0.00',
      icon: null,
      color: null,
      isActive: true,
      sortOrder: 0,
      overdraftLimit: null,
      cdiPercentage: null,
      parentAccountId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      openingBalance: '0.00',
      openingBalanceAnchorAt: null,
      isDefaultWallet: false,
    },
    config: {
      id: `cfg-${id}`,
      accountId: id,
      loanCategory: category,
      loanType: 'pessoal',
      totalInstallments: isPaidOff ? 1 : 12,
      monthlyPayment,
      dueDay: 5,
      monthlyInterestRate: '0.00000000',
      annualInterestRate: null,
      insuranceAmount: null,
      insurancePaymentDay: null,
      payoffCalculationType: null,
      principalAmount: null,
      originalAmount: null,
      startDate: new Date('2026-01-05T00:00:00Z'),
      comment: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    schedule: null,
    currentInstallment: isPaidOff ? 1 : 8,
    overdueCount: isPaidOff ? 0 : 1,
    isCurrentMonthPaid: isPaidOff,
    isPaidOff,
  };
}

function stubQueries(loans: ReturnType<typeof loanItem>[]) {
  server.use(
    http.get(`${TRPC_TEST_URL}/loan.list`, () =>
      HttpResponse.json({ result: { data: superjson.serialize(loans) } }),
    ),
    http.get(`${TRPC_TEST_URL}/loan.getPayoff`, () =>
      HttpResponse.json({
        result: {
          data: superjson.serialize({
            remainingInstallments: 4,
            outstandingBalance: '400.00',
            savings: '0.00',
            savingsPercent: 0,
          }),
        },
      }),
    ),
    http.get(`${TRPC_TEST_URL}/account.list`, () =>
      HttpResponse.json({ result: { data: superjson.serialize([]) } }),
    ),
  );
}

function renderPage() {
  return renderWithProviders(
    <TRPCTestProvider>
      <LoansClient />
    </TRPCTestProvider>,
  );
}

describe('LoansClient', () => {
  it('keeps paid-off loans collapsed and excludes them from primary counts and totals', async () => {
    stubQueries([
      loanItem('open-bank', 'Open Bank', 'bank', '100.00', false),
      loanItem('open-personal', 'Open Personal', 'personal', '200.00', false),
      loanItem('paid-bank', 'Paid Bank', 'bank', '900.00', true),
    ]);
    renderPage();

    expect(await screen.findByText('Open Bank')).toBeInTheDocument();
    expect(screen.getByText('Open Personal')).toBeInTheDocument();
    expect(screen.queryByText('Paid Bank')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Todos\s*\(2\)/i })).toBeInTheDocument();
    expect(screen.getAllByText('R$ 300,00')).toHaveLength(2);
    expect(screen.queryByText('R$ 1.200,00')).not.toBeInTheDocument();

    const paidOffTrigger = screen.getByRole('button', { name: /Empréstimos quitados \(1\)/i });
    expect(paidOffTrigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(paidOffTrigger);
    expect(await screen.findByText('Paid Bank')).toBeInTheDocument();
    expect(paidOffTrigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('applies the category filter to open and paid-off loans', async () => {
    stubQueries([
      loanItem('open-bank', 'Open Bank', 'bank', '100.00', false),
      loanItem('open-personal', 'Open Personal', 'personal', '200.00', false),
      loanItem('paid-bank', 'Paid Bank', 'bank', '900.00', true),
      loanItem('paid-personal', 'Paid Personal', 'personal', '800.00', true),
    ]);
    renderPage();

    fireEvent.click(await screen.findByRole('tab', { name: /Bancário\s*\(1\)/i }));
    expect(screen.getByText('Open Bank')).toBeInTheDocument();
    expect(screen.queryByText('Open Personal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Empréstimos quitados \(1\)/i }));
    expect(await screen.findByText('Paid Bank')).toBeInTheDocument();
    expect(screen.queryByText('Paid Personal')).not.toBeInTheDocument();
  });

  it('shows an open-list empty state when every loan is paid off', async () => {
    stubQueries([loanItem('paid-bank', 'Paid Bank', 'bank', '900.00', true)]);
    renderPage();

    expect(await screen.findByText('Nenhum empréstimo em aberto')).toBeInTheDocument();
    expect(screen.queryByText('Nenhum empréstimo cadastrado')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Empréstimos quitados \(1\)/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
