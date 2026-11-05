import type { AppRouter } from '@fc/api';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { inferRouterOutputs } from '@trpc/server';
import { HttpResponse, http } from 'msw';
import { toast } from 'sonner';
import superjson, { type SuperJSONResult } from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc/client';
import { renderDialog } from '@/test/dialog';
import { server } from '../../../test/msw-server';
import { EditChargeDialog } from '../EditChargeDialog';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

const TRPC_URL = 'http://localhost:3000/api/trpc';
type Charge = inferRouterOutputs<AppRouter>['charges']['list']['fixed'][number];

function isSuperJSONResult(value: unknown): value is SuperJSONResult {
  return typeof value === 'object' && value !== null && 'json' in value;
}

const charge: Charge = {
  id: '22222222-2222-2222-2222-222222222222',
  userId: '11111111-1111-1111-1111-111111111111',
  sourceAccountId: '33333333-3333-3333-3333-333333333333',
  destinationAccountId: '44444444-4444-4444-4444-444444444444',
  amount: '900.00',
  amountChanges: [],
  purchaseDate: null,
  purchaseDateSource: 'unknown',
  currency: 'BRL',
  description: 'Condomínio',
  categoryId: null,
  frequency: 'monthly',
  startDate: new Date('2026-01-10T00:00:00.000Z'),
  endDate: null,
  dueDay: 10,
  totalOccurrences: null,
  startingOccurrence: 1,
  isActive: true,
  notes: null,
  domainType: 'recurring_bill',
  domainConfigId: null,
  isFixedCharge: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  firstBillingMonth: null,
  firstBillingYear: null,
  transactionId: null,
  isPaid: false,
};

function ChargeListProbe() {
  trpc.charges.list.useQuery();
  return null;
}

function submitEdit() {
  fireEvent.change(screen.getByLabelText(/descri[çc][ãa]o/i), {
    target: { value: 'Condomínio Novo' },
  });
  fireEvent.change(screen.getByLabelText(/^valor/i), { target: { value: '950' } });
  fireEvent.change(screen.getByLabelText(/dia do vencimento/i), { target: { value: '15' } });
  fireEvent.change(screen.getByLabelText(/t[eé]rmino/i), { target: { value: '2026-12-15' } });
  fireEvent.submit(screen.getByLabelText(/descri[çc][ãa]o/i).closest('form') as HTMLFormElement);
}

afterEach(() => vi.clearAllMocks());

describe('EditChargeDialog', () => {
  it('preserves the edited payload and invalidates the active charge list', async () => {
    const updateCalls: SuperJSONResult[] = [];
    let listCalls = 0;
    server.use(
      http.post(`${TRPC_URL}/charges.update`, async ({ request }) => {
        const body = await request.json();
        if (!isSuperJSONResult(body)) throw new Error('expected a SuperJSON tRPC request body');
        updateCalls.push(body);
        return HttpResponse.json({ result: { data: superjson.serialize({ success: true }) } });
      }),
      http.get(`${TRPC_URL}/charges.list`, () => {
        listCalls += 1;
        return HttpResponse.json({
          result: { data: superjson.serialize({ fixed: [], oneTime: [], month: 1, year: 2026 }) },
        });
      }),
    );
    const onOpenChange = vi.fn();
    renderDialog(
      <>
        <EditChargeDialog open charge={charge} onOpenChange={onOpenChange} />
        <ChargeListProbe />
      </>,
    );
    submitEdit();

    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0].json).toMatchObject({
      scheduleId: charge.id,
      description: 'Condomínio Novo',
      amount: '950.00',
      dueDay: 15,
    });
    expect(superjson.deserialize<Record<string, unknown>>(updateCalls[0])).toMatchObject({
      endDate: new Date('2026-12-15T12:00:00'),
    });
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables the form and blocks cancel, Escape, and another submit while pending', async () => {
    const calls: unknown[] = [];
    let finishRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    server.use(
      http.post(`${TRPC_URL}/charges.update`, async ({ request }) => {
        calls.push(await request.json());
        await requestGate;
        return HttpResponse.json({ result: { data: superjson.serialize({ success: true }) } });
      }),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(<EditChargeDialog open charge={charge} onOpenChange={onOpenChange} />);
    submitEdit();

    await waitFor(() => expect(calls).toHaveLength(1));
    const submit = screen.getByRole('button', { name: /salvando/i });
    expect(submit).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancelar/i })).toBeDisabled();
    expect(screen.getByLabelText(/descri[çc][ãa]o/i)).toBeDisabled();
    await user.click(submit);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(calls).toHaveLength(1);
    expect(onOpenChange).not.toHaveBeenCalled();

    finishRequest?.();
  });

  it('shows the tRPC error message when the update fails', async () => {
    server.use(
      http.post(`${TRPC_URL}/charges.update`, () =>
        HttpResponse.json(
          {
            error: {
              json: {
                message: 'Não foi possível atualizar',
                code: -32603,
                data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'charges.update' },
              },
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderDialog(<EditChargeDialog open charge={charge} onOpenChange={() => {}} />);
    submitEdit();

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Não foi possível atualizar'),
    );
  });
});
