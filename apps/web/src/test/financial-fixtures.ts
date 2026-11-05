import type { FinancialObligation } from '@fc/shared';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { server } from './msw-server';
import { TRPC_TEST_URL } from './trpc';

export const obligationFixture: FinancialObligation = {
  key: 'transaction:installment-september',
  ref: {
    kind: 'loan_installment',
    loanAccountId: 'loan-1',
    transactionId: 'installment-september',
  },
  name: 'September installment',
  direction: 'payable',
  dueDate: '2026-09-10',
  currency: 'BRL',
  total: '100.00',
  remaining: '100.00',
  settledAmount: '0.00',
  confirmedCash: null,
  status: 'open',
  evidence: 'legacy',
  action: 'record_payment',
  revision: 'a'.repeat(64),
  accountIds: ['loan-1'],
  detailHref: '/loans/loan-1',
};
export function stubFinancialWallets(anchor = '2026-01-01T12:00:00Z') {
  server.use(
    http.get(`${TRPC_TEST_URL}/account.walletsOverview`, () =>
      HttpResponse.json({
        result: {
          data: superjson.serialize({
            wallets: [{ id: 'wallet-1', name: 'Conta Corrente', cash: 1000 }],
            totalCash: 1000,
          }),
        },
      }),
    ),
    http.get(`${TRPC_TEST_URL}/account.balanceAdjustmentPreview`, () =>
      HttpResponse.json({
        result: {
          data: superjson.serialize({
            walletId: 'wallet-1',
            name: 'Conta Corrente',
            cash: 1000,
            anchorAt: new Date(anchor),
            revision: 'b'.repeat(64),
          }),
        },
      }),
    ),
  );
}
