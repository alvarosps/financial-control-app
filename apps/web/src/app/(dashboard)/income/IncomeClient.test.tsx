import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { IncomeClient } from './IncomeClient';

describe('income source settlement badge', () => {
  it.each([
    { source: 'legacy', paid: true, label: 'Pago', evidence: 'Legado: origem não confirmada' },
    { source: 'manual', paid: true, label: 'Pago', evidence: 'Confirmado manualmente' },
    { source: 'date_assumed', paid: true, label: 'Pendente', evidence: 'Estimado por data' },
    { source: 'predicted', paid: false, label: 'Pendente', evidence: 'Previsto' },
  ])('separates $source evidence from the recorded settlement', async ({
    source,
    paid,
    label,
    evidence,
  }) => {
    const result = (value: unknown) =>
      HttpResponse.json({ result: { data: superjson.serialize(value) } });
    server.use(
      http.get(`${TRPC_TEST_URL}/income.list`, () =>
        result([
          {
            account: { id: 'income-1', name: 'Rental', currency: 'BRL' },
            config: {
              category: 'rental',
              frequency: 'monthly',
              paymentDay: 5,
              exchangeRate: null,
              conversionFeePercent: null,
            },
            schedule: { amount: '1400.00', startDate: new Date('2026-01-01') },
          },
        ]),
      ),
      http.get(`${TRPC_TEST_URL}/income.occurrences`, () =>
        result([
          {
            accountId: 'income-1',
            needsPayrollAllocation: false,
            occurrences: [
              {
                transactionId: 'receipt-1',
                date: '2026-09-05',
                amount: '1400.00',
                amountBrl: '1400.00',
                currency: 'BRL',
                cashAmountBrl: paid ? '1400.00' : null,
                settlementSource: source,
                isPaid: paid,
                cashConfirmed: source === 'manual',
                needsPayrollAllocation: false,
                payrollDeductionBrl: '0.00',
                settlementDate: null,
              },
            ],
          },
        ]),
      ),
      http.get(`${TRPC_TEST_URL}/account.list`, () => result([])),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <IncomeClient />
      </TRPCTestProvider>,
    );
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByText(evidence)).toBeInTheDocument();
    expect(screen.queryByText(label === 'Pago' ? 'Pendente' : 'Pago')).not.toBeInTheDocument();
    if (paid && source !== 'date_assumed') {
      expect(screen.getByRole('button', { name: 'Editar valor recebido' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Marcar recebida' })).not.toBeInTheDocument();
    }
  });
});
