import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';

type Purchase = inferRouterOutputs<AppRouter>['purchaseInbox']['list']['items'][number];
export function purchaseFixture(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    cardAccountId: '00000000-0000-4000-8000-000000000003',
    cardName: 'Local card',
    categoryId: null,
    description: 'Notebook',
    amount: '100.00',
    currency: 'BRL',
    amountMeaning: 'installment',
    kind: 'purchase',
    confirmation: 'observed',
    review: 'unreviewed',
    application: 'unapplied',
    manuallyCorrected: false,
    unrecognized: false,
    version: 1,
    purchaseDate: '2026-09-26',
    postedDate: null,
    installmentNumber: 1,
    totalInstallments: 3,
    mergedIntoId: null,
    createdAt: new Date('2026-09-26T12:00:00Z'),
    updatedAt: new Date('2026-09-26T12:00:00Z'),
    link: null,
    estimatedTotal: '300.00',
    appliedAmount: null,
    ledgerReversed: false,
    sources: ['manual'],
    ...overrides,
  };
}
