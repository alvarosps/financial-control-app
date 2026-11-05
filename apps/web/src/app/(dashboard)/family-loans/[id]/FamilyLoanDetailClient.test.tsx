import { fireEvent, screen, waitFor } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { FamilyLoanDetailClient } from './FamilyLoanDetailClient';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const CONFIG_ID = '11111111-1111-1111-1111-111111111111';
const SCHEDULE_ID = '22222222-2222-2222-2222-222222222222';

function response(data: unknown) {
  return HttpResponse.json({ result: { data: superjson.serialize(data) } });
}

describe('FamilyLoanDetailClient item deletion', () => {
  it('uses scheduled.delete and does not restore the item after refetch', async () => {
    let deleted = false;
    let monthlyCalls = 0;
    let ledgerCalls = 0;
    let projectionCalls = 0;
    const deleteCalls: unknown[] = [];

    server.use(
      http.get(`${TRPC_TEST_URL}/familyLoan.getById`, () =>
        response({
          config: { id: CONFIG_ID, receiptDay: 10 },
          account: {
            id: '33333333-3333-3333-3333-333333333333',
            name: 'Célia',
            type: 'family_loan',
            currency: 'BRL',
            isActive: true,
          },
          borrowedCards: [],
        }),
      ),
      http.get(`${TRPC_TEST_URL}/familyLoan.getMonthlyTotal`, () => {
        monthlyCalls += 1;
        return response({
          month: 7,
          year: 2026,
          installments: 0,
          fixedCharges: 0,
          oneTimeCharges: deleted ? 0 : 100,
          borrowedCardTotal: 0,
          borrowedCardBreakdown: [],
          discounts: 0,
          subtotal: deleted ? 0 : 100,
          total: deleted ? 0 : 100,
          items: {
            installments: [],
            fixedCharges: [],
            expenses: deleted
              ? []
              : [
                  {
                    id: '44444444-4444-4444-4444-444444444444',
                    description: 'Gasto teste',
                    amount: '100.00',
                    installmentNumber: null,
                    totalInstallments: null,
                    scheduledTransactionId: SCHEDULE_ID,
                    domainType: 'family_loan_expense',
                    isPaid: false,
                  },
                ],
            discounts: [],
          },
        });
      }),
      http.get(`${TRPC_TEST_URL}/familyLoan.getLedger`, () => {
        ledgerCalls += 1;
        return response({
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
      }),
      http.get(`${TRPC_TEST_URL}/familyLoan.get12MonthProjection`, () => {
        projectionCalls += 1;
        return response([]);
      }),
      http.get(`${TRPC_TEST_URL}/account.list`, () => response([])),
      http.post(`${TRPC_TEST_URL}/scheduled.delete`, async ({ request }) => {
        deleteCalls.push(await request.json());
        deleted = true;
        return response({ id: SCHEDULE_ID, deletedCount: 1 });
      }),
      http.post(`${TRPC_TEST_URL}/scheduled.deactivate`, () => {
        throw new Error('scheduled.deactivate must not be called');
      }),
    );

    renderWithProviders(
      <TRPCTestProvider>
        <FamilyLoanDetailClient configId={CONFIG_ID} initialMonth={7} initialYear={2026} />
      </TRPCTestProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /remover Gasto teste/i }));
    fireEvent.click(screen.getByRole('button', { name: /^remover$/i }));

    await waitFor(() => expect(deleteCalls).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('Gasto teste')).not.toBeInTheDocument());
    await waitFor(() => {
      expect(monthlyCalls).toBeGreaterThanOrEqual(2);
      expect(ledgerCalls).toBeGreaterThanOrEqual(2);
      expect(projectionCalls).toBeGreaterThanOrEqual(2);
    });
  });

  it('restores an optimistically removed item when scheduled.delete fails', async () => {
    let monthlyCalls = 0;
    server.use(
      http.get(`${TRPC_TEST_URL}/familyLoan.getById`, () =>
        response({
          config: { id: CONFIG_ID, receiptDay: 10 },
          account: {
            id: '33333333-3333-3333-3333-333333333333',
            name: 'Célia',
            type: 'family_loan',
            currency: 'BRL',
            isActive: true,
          },
          borrowedCards: [],
        }),
      ),
      http.get(`${TRPC_TEST_URL}/familyLoan.getMonthlyTotal`, async () => {
        monthlyCalls += 1;
        if (monthlyCalls > 1) await delay(500);
        return response({
          month: 7,
          year: 2026,
          installments: 0,
          fixedCharges: 0,
          oneTimeCharges: 100,
          borrowedCardTotal: 0,
          borrowedCardBreakdown: [],
          discounts: 0,
          subtotal: 100,
          total: 100,
          items: {
            installments: [],
            fixedCharges: [],
            expenses: [
              {
                id: '44444444-4444-4444-4444-444444444444',
                description: 'Gasto preservado',
                amount: '100.00',
                installmentNumber: null,
                totalInstallments: null,
                scheduledTransactionId: SCHEDULE_ID,
                domainType: 'family_loan_expense',
                isPaid: false,
              },
            ],
            discounts: [],
          },
        });
      }),
      http.get(`${TRPC_TEST_URL}/familyLoan.getLedger`, () =>
        response({
          months: [],
          totals: {
            totalOutstanding: 0,
            totalOverdue: 0,
            totalOwed: 0,
            totalPaid: 0,
            creditBalance: 0,
          },
          payments: [],
        }),
      ),
      http.get(`${TRPC_TEST_URL}/familyLoan.get12MonthProjection`, () => response([])),
      http.get(`${TRPC_TEST_URL}/account.list`, () => response([])),
      http.post(`${TRPC_TEST_URL}/scheduled.delete`, async () => {
        await delay(100);
        return HttpResponse.json(
          {
            error: {
              json: {
                message: 'Não foi possível remover',
                code: -32603,
                data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
              },
            },
          },
          { status: 500 },
        );
      }),
    );

    renderWithProviders(
      <TRPCTestProvider>
        <FamilyLoanDetailClient configId={CONFIG_ID} initialMonth={7} initialYear={2026} />
      </TRPCTestProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /remover Gasto preservado/i }));
    fireEvent.click(screen.getByRole('button', { name: /^remover$/i }));

    await waitFor(() => expect(screen.queryByTitle('Gasto preservado')).not.toBeInTheDocument());
    expect(await screen.findByTitle('Gasto preservado')).toBeInTheDocument();
  });
});
