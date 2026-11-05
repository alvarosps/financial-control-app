import { fireEvent, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/msw-server';
import { installHistorySync, resetFakeSearchParams } from '@/test/next-navigation-fake';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { DailyClient } from './DailyClient';

vi.mock('next/navigation', async () => {
  const fake = await import('@/test/next-navigation-fake');
  return { useSearchParams: fake.useFakeSearchParams };
});

function payload(month: number, name: string) {
  return {
    month,
    year: 2026,
    days: [
      {
        date: `2026-${String(month).padStart(2, '0')}-10`,
        items: [
          {
            kind: 'fixed_charge',
            id: `charge-${month}`,
            name,
            date: `2026-${String(month).padStart(2, '0')}-10`,
            amount: 100,
            direction: 'out',
            isPaid: false,
          },
        ],
      },
    ],
    summary: {
      totalItems: 1,
      paidCount: 0,
      pendingCount: 1,
      totalIn: 0,
      totalOut: 100,
      balance: -100,
    },
  };
}

describe('DailyClient month navigation', () => {
  let restoreHistory: () => void;

  beforeEach(() => {
    window.history.replaceState(null, '', '/daily');
    resetFakeSearchParams();
    restoreHistory = installHistorySync();
  });

  afterEach(() => restoreHistory());

  it('keeps the previous month visible while the next month is pending', async () => {
    let releaseJuly: () => void = () => {};
    const julyGate = new Promise<void>((resolve) => {
      releaseJuly = resolve;
    });
    server.use(
      http.get(`${TRPC_TEST_URL}/dashboard.dailyControl`, async ({ request }) => {
        const rawInput = new URL(request.url).searchParams.get('input') ?? '{}';
        const input = JSON.parse(rawInput) as { json?: { month?: number } };
        const month = input.json?.month ?? 0;
        if (month === 7) await julyGate;
        return HttpResponse.json({
          result: {
            data: superjson.serialize(payload(month, month === 7 ? 'Conta julho' : 'Conta junho')),
          },
        });
      }),
    );

    renderWithProviders(
      <TRPCTestProvider>
        <DailyClient initialMonth={6} initialYear={2026} />
      </TRPCTestProvider>,
    );

    expect(await screen.findByText('Conta junho')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    expect(screen.getByText('Conta junho')).toBeInTheDocument();
    expect(screen.queryByTestId('skeleton-card')).not.toBeInTheDocument();

    releaseJuly();
    expect(await screen.findByText('Conta julho')).toBeInTheDocument();
  });

  it('staggers each day group in display order', async () => {
    server.use(
      http.get(`${TRPC_TEST_URL}/dashboard.dailyControl`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              ...payload(6, 'Conta junho'),
              days: [
                ...payload(6, 'Conta junho').days,
                {
                  ...payload(6, 'Outra conta').days[0],
                  date: '2026-06-11',
                  items: [
                    {
                      ...payload(6, 'Outra conta').days[0].items[0],
                      date: '2026-06-11',
                    },
                  ],
                },
              ],
            }),
          },
        }),
      ),
    );

    renderWithProviders(
      <TRPCTestProvider>
        <DailyClient initialMonth={6} initialYear={2026} />
      </TRPCTestProvider>,
    );

    const firstGroup = (await screen.findByText('Conta junho')).closest('.stagger-item');
    const secondGroup = screen.getByText('Outra conta').closest('.stagger-item');

    expect(firstGroup).toHaveStyle({ '--stagger-index': '0' });
    expect(secondGroup).toHaveStyle({ '--stagger-index': '1' });
  });
});
