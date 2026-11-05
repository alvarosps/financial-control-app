import { waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { trpc } from '@/lib/trpc/client';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { useAutoCreditToast } from './useAutoCreditToast';

function DashboardQueries() {
  trpc.dashboard.upcomingItems.useQuery({ days: 30 });
  trpc.dashboard.monthlySummary.useQuery({ month: 6, year: 2026 });
  trpc.dashboard.dailyControl.useQuery({ month: 6, year: 2026 });
  trpc.dashboard.monthStatus.useQuery({ month: 6, year: 2026 });
  trpc.dashboard.monthOverview.useQuery({ month: 6, year: 2026 });
  trpc.dashboard.cashFlow.useQuery({ months: 6 });
  trpc.account.walletsOverview.useQuery();
  useAutoCreditToast();
  return null;
}

describe('useAutoCreditToast', () => {
  it('refreshes hydrated dashboard and wallet queries after it credits due income', async () => {
    const calls = new Map<string, number>();
    const procedures = [
      'dashboard.upcomingItems',
      'dashboard.monthlySummary',
      'dashboard.dailyControl',
      'dashboard.monthStatus',
      'dashboard.monthOverview',
      'dashboard.cashFlow',
      'account.walletsOverview',
    ];
    server.use(
      ...procedures.map((procedure) =>
        http.get(`${TRPC_TEST_URL}/${procedure}`, () => {
          calls.set(procedure, (calls.get(procedure) ?? 0) + 1);
          return HttpResponse.json({ result: { data: superjson.serialize({}) } });
        }),
      ),
      http.get(`${TRPC_TEST_URL}/income.autoCreditDue`, () =>
        HttpResponse.json({
          result: { data: superjson.serialize({ credited: [{ id: 'income-1' }] }) },
        }),
      ),
    );

    renderWithProviders(
      <TRPCTestProvider>
        <DashboardQueries />
      </TRPCTestProvider>,
    );

    await waitFor(() => {
      for (const procedure of procedures) {
        expect(calls.get(procedure)).toBeGreaterThanOrEqual(2);
      }
    });
  });
});
