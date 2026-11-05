import type { SimScenario } from '@fc/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../test/msw-server';
import type { SavedScenarioRow } from '../SavedScenarioCard';
import { useSavedScenarioActions } from '../use-saved-scenario-actions';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

const TRPC_URL = 'http://localhost:3000/api/trpc';

const SCENARIO: SimScenario = {
  name: 'Plano X',
  horizon: 6,
  openingBalanceOverride: '2500.00',
  levers: [
    {
      kind: 'one_time_event',
      id: 'e1',
      sign: 'outflow',
      amount: '300.00',
      month: { month: 7, year: 2026 },
      label: 'Compra',
    },
  ],
};

const ROW: SavedScenarioRow = {
  id: 'scn-9',
  name: 'Plano X',
  createdAt: '2026-06-10T00:00:00.000Z',
  scenario: SCENARIO,
};

function Wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const trpcClient = trpc.createClient({
    links: [httpLink({ url: TRPC_URL, transformer: superjson })],
  });
  return (
    <NextIntlClientProvider
      locale="pt-BR"
      messages={{}}
      onError={() => {}}
      getMessageFallback={({ key }) => key}
    >
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </NextIntlClientProvider>
  );
}

function Harness({ onLoad }: { onLoad: (s: SimScenario) => void }) {
  const { onRerun, onDuplicate } = useSavedScenarioActions({ loadScenario: onLoad });
  return (
    <div>
      <button type="button" onClick={() => onRerun(ROW)}>
        rerun
      </button>
      <button type="button" onClick={() => onDuplicate(ROW)}>
        duplicate
      </button>
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSavedScenarioActions', () => {
  it('re-run loads the saved scenario back into the panel', async () => {
    const user = userEvent.setup();
    const loaded: SimScenario[] = [];
    render(<Harness onLoad={(s) => loaded.push(s)} />, { wrapper: Wrapper });

    await user.click(screen.getByText('rerun'));

    expect(loaded).toHaveLength(1);
    expect(loaded[0].levers).toHaveLength(1);
    expect(loaded[0].levers[0].kind).toBe('one_time_event');
    expect(loaded[0].openingBalanceOverride).toBe('2500.00');
    expect(loaded[0].horizon).toBe(6);
  });

  it('duplicate calls duplicateScenario with the row id', async () => {
    const user = userEvent.setup();
    const calls: Array<{ json?: { id: string } }> = [];
    server.use(
      http.post(`${TRPC_URL}/simulator.duplicateScenario`, async ({ request }) => {
        calls.push((await request.json()) as { json?: { id: string } });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'scn-10' }) } });
      }),
    );

    render(<Harness onLoad={() => {}} />, { wrapper: Wrapper });
    await user.click(screen.getByText('duplicate'));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].json?.id).toBe('scn-9');
  });
});
