import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/msw-server';
import { installHistorySync } from '@/test/next-navigation-fake';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { TransactionsClient } from './TransactionsClient';

vi.mock('next/navigation', async () => {
  const fake = await import('@/test/next-navigation-fake');
  return { useSearchParams: fake.useFakeSearchParams };
});

let restoreHistory = () => {};
beforeEach(() => {
  restoreHistory = installHistorySync();
});
afterEach(() => restoreHistory());

describe('transaction views', () => {
  it('keeps month, account and obligation filter while switching to paginated details and back', async () => {
    window.history.replaceState(
      null,
      '',
      '/transactions?month=8&year=2026&accountId=wallet-1&filter=payable',
    );
    const requests: Record<string, unknown>[] = [];
    const result = (data: unknown) =>
      HttpResponse.json({ result: { data: superjson.serialize(data) } });
    server.use(
      http.get(`${TRPC_TEST_URL}/account.list`, () =>
        result([{ id: 'wallet-1', name: 'Conta principal', type: 'checking' }]),
      ),
      http.get(`${TRPC_TEST_URL}/transaction.obligations`, () =>
        result({
          items: [],
          reviewIssues: [],
          summary: {
            payableCount: 0,
            receivableCount: 0,
            reviewCount: 0,
            toPay: '0.00',
            toReceive: '0.00',
          },
        }),
      ),
      http.get(`${TRPC_TEST_URL}/transaction.details`, ({ request }) => {
        requests.push(JSON.parse(new URL(request.url).searchParams.get('input') ?? '{}').json);
        return result({ items: [], page: 1, pageSize: 40, total: 0, totalPages: 0 });
      }),
      http.get(`${TRPC_TEST_URL}/category.list`, () => result([])),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <TransactionsClient initialMonth={9} initialYear={2026} />
      </TRPCTestProvider>,
    );
    expect(await screen.findByRole('button', { name: 'A pagar (0)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Detalhamento contábil' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      month: 8,
      year: 2026,
      accountId: 'wallet-1',
      page: 1,
      pageSize: 40,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resumo do mês' }));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('filter')).toBe('payable');
    expect(params.get('month')).toBe('8');
    expect(params.get('accountId')).toBe('wallet-1');
  });
});
