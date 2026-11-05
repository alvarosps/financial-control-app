import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { toast } from 'sonner';
import superjson, { type SuperJSONResult } from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc/client';
import { renderDialog } from '@/test/dialog';
import { server } from '../../../test/msw-server';
import { AddChargeDialog } from '../AddChargeDialog';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

const TRPC_URL = 'http://localhost:3000/api/trpc';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

function isSuperJSONResult(value: unknown): value is SuperJSONResult {
  return typeof value === 'object' && value !== null && 'json' in value;
}

function ChargeListProbe() {
  trpc.charges.list.useQuery();
  return null;
}

function seedAccounts() {
  const response = () =>
    HttpResponse.json({
      result: {
        data: superjson.serialize([
          { id: ACCOUNT_ID, name: 'Conta Corrente', type: 'checking', isActive: true },
        ]),
      },
    });
  server.use(
    http.get(`${TRPC_URL}/account.list`, response),
    http.post(`${TRPC_URL}/account.list`, response),
  );
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(screen.getByLabelText(/descri[çc][ãa]o/i), { target: { value: 'Aluguel' } });
  fireEvent.change(screen.getByLabelText(/^valor/i), { target: { value: '1500' } });
  fireEvent.change(screen.getByLabelText(/dia do vencimento/i), { target: { value: '10' } });
  await user.click(screen.getByLabelText(/pagar de/i));
  await user.click(await screen.findByRole('option', { name: 'Conta Corrente' }));
}

afterEach(() => vi.clearAllMocks());

describe('AddChargeDialog', () => {
  it('sends the canonical fixed-charge payload and invalidates the active charge list', async () => {
    seedAccounts();
    const createCalls: SuperJSONResult[] = [];
    let listCalls = 0;
    server.use(
      http.post(`${TRPC_URL}/charges.createFixed`, async ({ request }) => {
        const body = await request.json();
        if (!isSuperJSONResult(body)) throw new Error('expected a SuperJSON tRPC request body');
        createCalls.push(body);
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
      http.get(`${TRPC_URL}/charges.list`, () => {
        listCalls += 1;
        return HttpResponse.json({
          result: { data: superjson.serialize({ fixed: [], oneTime: [], month: 1, year: 2026 }) },
        });
      }),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(
      <>
        <AddChargeDialog open onOpenChange={onOpenChange} />
        <ChargeListProbe />
      </>,
    );

    await fillRequiredFields(user);
    fireEvent.change(screen.getByLabelText(/in[ií]cio/i), { target: { value: '2026-06-10' } });
    fireEvent.change(screen.getByLabelText(/t[eé]rmino/i), { target: { value: '2026-12-10' } });
    fireEvent.submit(screen.getByLabelText(/descri[çc][ãa]o/i).closest('form') as HTMLFormElement);

    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0].json).toMatchObject({
      description: 'Aluguel',
      amount: '1500.00',
      sourceAccountId: ACCOUNT_ID,
      dueDay: 10,
    });
    expect(superjson.deserialize<Record<string, unknown>>(createCalls[0])).toMatchObject({
      startDate: new Date('2026-06-10T12:00:00'),
      endDate: new Date('2026-12-10T12:00:00'),
    });
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('blocks another submit and every close path while its mutation is pending', async () => {
    seedAccounts();
    const createCalls: unknown[] = [];
    let finishRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    server.use(
      http.post(`${TRPC_URL}/charges.createFixed`, async ({ request }) => {
        createCalls.push(await request.json());
        await requestGate;
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(<AddChargeDialog open onOpenChange={onOpenChange} />);

    await fillRequiredFields(user);
    const submit = screen.getByRole('button', { name: /^adicionar$/i });
    await user.click(submit);
    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(submit).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancelar/i })).toBeDisabled();
    expect(screen.getByLabelText(/descri[çc][ãa]o/i)).toBeDisabled();
    await user.click(submit);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(createCalls).toHaveLength(1);
    expect(onOpenChange).not.toHaveBeenCalled();

    finishRequest?.();
  });

  it('shows the tRPC error message when creation fails', async () => {
    seedAccounts();
    server.use(
      http.post(`${TRPC_URL}/charges.createFixed`, () =>
        HttpResponse.json(
          {
            error: {
              json: {
                message: 'Falha da API',
                code: -32603,
                data: {
                  code: 'INTERNAL_SERVER_ERROR',
                  httpStatus: 500,
                  path: 'charges.createFixed',
                },
              },
            },
          },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderDialog(<AddChargeDialog open onOpenChange={() => {}} />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /^adicionar$/i }));

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Falha da API'));
  });
});
