import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { toast } from 'sonner';
import superjson, { type SuperJSONResult } from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc/client';
import { renderDialog } from '@/test/dialog';
import { server } from '../../../test/msw-server';
import { AddLoanDialog } from '../AddLoanDialog';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

const TRPC_URL = 'http://localhost:3000/api/trpc';
const ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';

function isSuperJSONResult(value: unknown): value is SuperJSONResult {
  return typeof value === 'object' && value !== null && 'json' in value;
}

function LoanListProbe() {
  trpc.loan.list.useQuery();
  return null;
}

function seedAccounts() {
  const response = () =>
    HttpResponse.json({
      result: {
        data: superjson.serialize([
          { id: ACCOUNT_ID, name: 'Conta para Débito', type: 'checking', isActive: true },
        ]),
      },
    });
  server.use(
    http.get(`${TRPC_URL}/account.list`, response),
    http.post(`${TRPC_URL}/account.list`, response),
  );
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(screen.getByLabelText(/nome do empr[eé]stimo/i), { target: { value: 'Carro' } });
  fireEvent.change(screen.getByLabelText(/valor da parcela/i), { target: { value: '850' } });
  fireEvent.change(screen.getByLabelText(/total de parcelas/i), { target: { value: '48' } });
  fireEvent.change(screen.getByLabelText(/dia de vencimento/i), { target: { value: '12' } });
  fireEvent.change(screen.getByLabelText(/taxa de juros mensal/i), { target: { value: '1.5' } });
  await user.click(screen.getByLabelText(/conta para d[eé]bito/i));
  await user.click(await screen.findByRole('option', { name: 'Conta para Débito' }));
}

afterEach(() => vi.clearAllMocks());

describe('AddLoanDialog', () => {
  it('sends the current loan payload and invalidates the active loan list', async () => {
    seedAccounts();
    const createCalls: SuperJSONResult[] = [];
    let listCalls = 0;
    server.use(
      http.post(`${TRPC_URL}/loan.create`, async ({ request }) => {
        const body = await request.json();
        if (!isSuperJSONResult(body)) throw new Error('expected a SuperJSON tRPC request body');
        createCalls.push(body);
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
      http.get(`${TRPC_URL}/loan.list`, () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(
      <>
        <AddLoanDialog open onOpenChange={onOpenChange} />
        <LoanListProbe />
      </>,
    );

    await fillRequiredFields(user);
    fireEvent.change(screen.getByLabelText(/data primeira parcela/i), {
      target: { value: '2026-08-12' },
    });
    fireEvent.change(screen.getByLabelText(/parcela atual/i), { target: { value: '3' } });
    fireEvent.submit(
      screen.getByLabelText(/nome do empr[eé]stimo/i).closest('form') as HTMLFormElement,
    );

    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0].json).toMatchObject({
      name: 'Carro',
      loanCategory: 'bank',
      loanType: 'pessoal',
      monthlyPayment: '850.00',
      totalInstallments: 48,
      currentInstallment: 3,
      dueDay: 12,
      checkingAccountId: ACCOUNT_ID,
      monthlyInterestRate: '0.015',
    });
    expect(superjson.deserialize<Record<string, unknown>>(createCalls[0])).toMatchObject({
      startDate: new Date('2026-08-12T12:00:00'),
    });
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('blocks another submit, cancel, and Escape while creation is pending', async () => {
    seedAccounts();
    const calls: unknown[] = [];
    let finishRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    server.use(
      http.post(`${TRPC_URL}/loan.create`, async ({ request }) => {
        calls.push(await request.json());
        await requestGate;
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(<AddLoanDialog open onOpenChange={onOpenChange} />);

    await fillRequiredFields(user);
    const submit = screen.getByRole('button', { name: /^adicionar$/i });
    await user.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(submit).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancelar/i })).toBeDisabled();
    expect(screen.getByLabelText(/nome do empr[eé]stimo/i)).toBeDisabled();
    await user.click(submit);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(calls).toHaveLength(1);
    expect(onOpenChange).not.toHaveBeenCalled();

    finishRequest?.();
  });

  it('shows the tRPC error message when creation fails', async () => {
    seedAccounts();
    server.use(
      http.post(`${TRPC_URL}/loan.create`, () =>
        HttpResponse.json(
          {
            error: {
              json: {
                message: 'Não foi possível cadastrar',
                code: -32603,
                data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'loan.create' },
              },
            },
          },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderDialog(<AddLoanDialog open onOpenChange={() => {}} />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /^adicionar$/i }));

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Não foi possível cadastrar'),
    );
  });
});
