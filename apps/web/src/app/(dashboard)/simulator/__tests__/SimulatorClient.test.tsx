/**
 * SimulatorClient integration test.
 *
 * Renders the real run-driven client inside the real NextIntl + tRPC provider
 * stack. The client fires `simulator.run` on mount (a tRPC query → GET, stubbed
 * via msw) and composes the KPI grid, running-balance chart, month table and
 * alerts from the run payload. Provider + msw harness mirrors LoanCard.test.tsx.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import type * as React from 'react';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import rawPtMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../../test/msw-server';
import { SimulatorClient } from '../SimulatorClient';

// `ssr: false` dynamic components remain on their loading fallback in Vitest.
// Resolve them in this client-composition test; the chart itself keeps its own
// focused component tests and production retains Next's lazy loading.
vi.mock('next/dynamic', async () => {
  const React = await import('react');

  return {
    default: <Props extends object>(
      load: () => Promise<React.ComponentType<Props>>,
      options?: { loading?: () => React.ReactNode },
    ) => {
      function DynamicComponent(props: Props) {
        const [Component, setComponent] = React.useState<React.ComponentType<Props> | null>(null);

        React.useEffect(() => {
          let active = true;
          load().then((LoadedComponent) => {
            if (active) setComponent(() => LoadedComponent);
          });
          return () => {
            active = false;
          };
        }, []);

        return Component ? <Component {...props} /> : (options?.loading?.() ?? null);
      }

      return DynamicComponent;
    },
  };
});

// Rehydrate i18n messages so `t('ns.hash')` resolves (mirrors test/render.tsx).
const rawExtracted = (rawPtMessages as Record<string, unknown>).extracted ?? {};
const nestedExtracted: Record<string, Record<string, string>> = {};
for (const [flatKey, value] of Object.entries(rawExtracted as Record<string, string>)) {
  const dot = flatKey.indexOf('.');
  if (dot === -1) continue;
  const ns = flatKey.slice(0, dot);
  const leaf = flatKey.slice(dot + 1);
  if (!nestedExtracted[ns]) nestedExtracted[ns] = {};
  nestedExtracted[ns][leaf] = value;
}
const { extracted: _dropped, ...restMessages } = rawPtMessages as Record<string, unknown>;
const ptMessages = { ...restMessages, ...nestedExtracted };

const TRPC_URL = 'http://localhost:3000/api/trpc';

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const trpcClient = trpc.createClient({
    links: [httpLink({ url: TRPC_URL, transformer: superjson })],
  });
  return (
    <NextIntlClientProvider
      locale="pt-BR"
      messages={ptMessages as Record<string, unknown>}
      onError={() => {}}
      getMessageFallback={({ key }) => key}
    >
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </NextIntlClientProvider>
  );
}

function projMonth(month: number, ending: number) {
  return {
    month,
    year: 2026,
    openingBalance: ending - 500,
    income: { base: 5000, familyLoan: 0, lever: 0, total: 5000 },
    expenses: { creditCard: 4500, loan: 0, charge: 0, other: 0, lever: 0, total: 4500 },
    net: 500,
    endingBalance: ending,
    events: [],
  };
}

function stubRun() {
  const baseline = [projMonth(6, 1500), projMonth(7, 2000)];
  const simulated = [projMonth(6, 1700), projMonth(7, 2400)];
  server.use(
    http.get(`${TRPC_URL}/simulator.run`, () =>
      HttpResponse.json({
        result: {
          data: superjson.serialize({
            anchorCash: 1000,
            openingBalance: 1000,
            baseline,
            simulated,
            kpis: {
              openingNow: 1000,
              endingBaseline: 2000,
              endingSimulated: 2400,
              delta: 400,
            },
            alerts: {
              firstNegativeMonthBaseline: null,
              firstNegativeMonthSimulated: null,
              troughBaseline: { month: 6, year: 2026, balance: 1500 },
              troughSimulated: { month: 6, year: 2026, balance: 1700 },
            },
            forecast: [],
            assumptions: {
              familyReceiptPercent: 100,
              horizon: 12,
              anchorSource: 'wallet_cash',
              openingBalanceOverridden: false,
              asOf: '2026-06-16',
              currency: 'BRL',
            },
          }),
        },
      }),
    ),
  );
}

function stubListScenarios(rows: unknown[]) {
  server.use(
    http.get(`${TRPC_URL}/simulator.listScenarios`, () =>
      HttpResponse.json({
        result: { data: superjson.serialize(rows) },
      }),
    ),
  );
}

describe('SimulatorClient', () => {
  it('renders the KPI grid, chart, month table and alerts from a run payload', async () => {
    stubRun();
    stubListScenarios([]);
    render(<SimulatorClient />, { wrapper: TestWrapper });

    // KPI labels (Task 17).
    expect(await screen.findByText('Saldo atual')).toBeInTheDocument();
    expect(screen.getByText('Final simulado')).toBeInTheDocument();
    // Chart card title (Task 18).
    expect(await screen.findByText('Saldo acumulado', {}, { timeout: 5000 })).toBeInTheDocument();
    // Month table title + a month row (Task 19). The shared monthYearLabel helper
    // (Task 13) strips the pt-BR short-month trailing dot, so it reads `jun/2026`.
    expect(screen.getByText('Mês a mês')).toBeInTheDocument();
    expect(screen.getByText('jun/2026')).toBeInTheDocument();
    // Alerts: never negative -> positive message (Task 20).
    expect(screen.getByText('Permanece positivo em todo o horizonte')).toBeInTheDocument();
  });

  it('opens the export dialog from the Export button once a run is loaded', async () => {
    stubRun();
    stubListScenarios([]);
    const user = userEvent.setup();
    render(<SimulatorClient />, { wrapper: TestWrapper });

    const exportBtn = await screen.findByRole('button', { name: 'Exportar' });
    // The button is disabled until the run query resolves (`!data`).
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    await user.click(exportBtn);

    // The dialog title (Task 28) confirms ExportScenarioDialog is mounted/open.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Exportar cenário' })).toBeInTheDocument(),
    );
  });

  it('runs each selected scenario and overlays both in the compare chart', async () => {
    stubRun();
    // Distinct horizons keep the per-scenario run query keys distinct (and apart
    // from the live `horizon: 12` run) so TanStack Query does not dedupe them and
    // each compared scenario issues its own `simulator.run`.
    const scenarioRow = (id: string, scenarioName: string, horizon: number) => ({
      id,
      userId: 'user-1',
      name: scenarioName,
      type: 'scenario',
      parameters: { name: scenarioName, horizon, levers: [] },
      results: null,
      createdAt: new Date('2026-06-10T12:00:00.000Z'),
      updatedAt: new Date('2026-06-10T12:00:00.000Z'),
    });
    stubListScenarios([scenarioRow('scn-a', 'Plano A', 11), scenarioRow('scn-b', 'Plano B', 10)]);

    // Count how many `simulator.run` GETs fire so we can assert both selected
    // scenarios were actually run (the live run + one per compared scenario).
    let runCalls = 0;
    server.use(
      http.get(`${TRPC_URL}/simulator.run`, () => {
        runCalls += 1;
        const baseline = [projMonth(6, 1500), projMonth(7, 2000)];
        const simulated = [projMonth(6, 1700), projMonth(7, 2400)];
        return HttpResponse.json({
          result: {
            data: superjson.serialize({
              anchorCash: 1000,
              openingBalance: 1000,
              baseline,
              simulated,
              kpis: { openingNow: 1000, endingBaseline: 2000, endingSimulated: 2400, delta: 400 },
              alerts: {
                firstNegativeMonthBaseline: null,
                firstNegativeMonthSimulated: null,
                troughBaseline: { month: 6, year: 2026, balance: 1500 },
                troughSimulated: { month: 6, year: 2026, balance: 1700 },
              },
              forecast: [],
              assumptions: {
                familyReceiptPercent: 100,
                horizon: 12,
                anchorSource: 'wallet_cash',
                openingBalanceOverridden: false,
                asOf: '2026-06-16',
                currency: 'BRL',
              },
            }),
          },
        });
      }),
    );

    const user = userEvent.setup();
    render(<SimulatorClient />, { wrapper: TestWrapper });

    // Select both saved scenarios via their compare checkboxes.
    const compareA = await screen.findByRole('checkbox', { name: 'Comparar cenário Plano A' });
    const compareB = screen.getByRole('checkbox', { name: 'Comparar cenário Plano B' });
    await user.click(compareA);
    await user.click(compareB);

    // The compare overlay renders its title and both scenario names in the legend.
    expect(await screen.findByText('Comparação de cenários')).toBeInTheDocument();
    await waitFor(() => {
      // Each scenario name appears once on its card and once in the compare legend.
      expect(screen.getAllByText('Plano A').length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText('Plano B').length).toBeGreaterThanOrEqual(2);
    });

    // The live run plus one run per compared scenario all fired.
    expect(runCalls).toBeGreaterThanOrEqual(3);
  });

  it('saves the current scenario and lists the new card after invalidation', async () => {
    stubRun();
    // Start with no saved scenarios; flip to one row once the save mutation
    // lands so the post-save `listScenarios` invalidation re-renders the card.
    stubListScenarios([]);
    const user = userEvent.setup();

    const savedRow = {
      id: 'scn-1',
      userId: 'user-1',
      name: 'Meu cenário',
      type: 'scenario',
      parameters: { name: 'Meu cenário', horizon: 12, levers: [] },
      results: null,
      createdAt: new Date('2026-06-10T12:00:00.000Z'),
      updatedAt: new Date('2026-06-10T12:00:00.000Z'),
    };

    const saved: unknown[] = [];
    server.use(
      http.post(`${TRPC_URL}/simulator.saveScenario`, async ({ request }) => {
        saved.push(await request.json());
        // Subsequent listScenarios fetches now return the persisted row.
        stubListScenarios([savedRow]);
        return HttpResponse.json({
          result: { data: superjson.serialize(savedRow) },
        });
      }),
    );

    render(<SimulatorClient />, { wrapper: TestWrapper });

    // The saved-scenarios heading and empty state render once listScenarios resolves.
    expect(await screen.findByText('Cenários salvos')).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText('Dê um nome a este cenário');
    await user.type(nameInput, 'Meu cenário');
    await user.click(screen.getByRole('button', { name: 'Salvar cenário' }));

    // The mutation fired with the live scenario built from client state.
    await waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0]).toMatchObject({
      json: { name: 'Meu cenário', horizon: 12, levers: [] },
    });

    // After invalidation the new card appears in the list.
    expect(await screen.findByText('Meu cenário')).toBeInTheDocument();
  });
});
