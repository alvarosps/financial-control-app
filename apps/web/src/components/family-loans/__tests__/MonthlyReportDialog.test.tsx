import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDialog } from '@/test/dialog';
import { server } from '@/test/msw-server';
import { TRPC_TEST_URL } from '@/test/trpc';
import { MonthlyReportDialog } from '../MonthlyReportDialog';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

const CONFIG_ID = '11111111-1111-1111-1111-111111111111';
const CARD_ID = '22222222-2222-2222-2222-222222222222';
const clipboardWrite = vi.fn();

function response(data: unknown) {
  return HttpResponse.json({ result: { data: superjson.serialize(data) } });
}

function monthly(overrides: Record<string, unknown> = {}) {
  return {
    month: 8,
    year: 2026,
    installments: 100,
    fixedCharges: 0,
    oneTimeCharges: 50,
    borrowedCardTotal: 25,
    borrowedCardBreakdown: [{ creditCardAccountId: CARD_ID, total: 25 }],
    discounts: 10,
    subtotal: 175,
    total: 165,
    items: {
      installments: [
        {
          id: '33333333-3333-3333-3333-333333333333',
          description: 'Parcela teste',
          amount: '100.00',
          installmentNumber: 2,
          totalInstallments: 12,
          scheduledTransactionId: '44444444-4444-4444-4444-444444444444',
          domainType: 'family_loan_installment',
          isPaid: false,
        },
      ],
      fixedCharges: [],
      expenses: [
        {
          id: '55555555-5555-5555-5555-555555555555',
          description: 'Mercado',
          amount: '50.00',
          installmentNumber: null,
          totalInstallments: null,
          scheduledTransactionId: '66666666-6666-6666-6666-666666666666',
          domainType: 'family_loan_expense',
          isPaid: false,
        },
      ],
      discounts: [
        {
          id: '77777777-7777-7777-7777-777777777777',
          description: 'Desconto',
          amount: '10.00',
          installmentNumber: null,
          totalInstallments: null,
          scheduledTransactionId: '88888888-8888-8888-8888-888888888888',
          domainType: 'family_loan_discount',
          isPaid: false,
        },
      ],
    },
    ...overrides,
  };
}

function TestHarness({ cardNameMap = new Map([[CARD_ID, 'Trigg']]) }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir
      </button>
      <MonthlyReportDialog
        open={open}
        onOpenChange={setOpen}
        configId={CONFIG_ID}
        initialMonth={7}
        initialYear={2026}
        cardNameMap={cardNameMap}
      />
    </>
  );
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  clipboardWrite.mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe('MonthlyReportDialog', () => {
  it('only fetches after generate, uses the selected month, and copies the preview', async () => {
    const calls: Array<{ month: number; year: number }> = [];
    server.use(
      http.get(`${TRPC_TEST_URL}/familyLoan.getMonthlyTotal`, ({ request }) => {
        const input = JSON.parse(new URL(request.url).searchParams.get('input') ?? '{}');
        calls.push(input.json);
        return response(monthly());
      }),
    );
    renderDialog(<TestHarness />);

    expect(calls).toHaveLength(0);
    const generateButton = screen.getByRole('button', { name: /gerar relatório/i });
    const copyButton = screen.getByRole('button', { name: /copiar texto/i });
    expect(generateButton.parentElement).toContainElement(copyButton);
    expect(copyButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/mês do relatório/i), {
      target: { value: '2026-08' },
    });
    fireEvent.click(generateButton);

    await waitFor(() => expect(calls).toEqual([{ month: 8, year: 2026, configId: CONFIG_ID }]));
    const preview = await screen.findByText(/AGOSTO\/2026/);
    expect(preview).toHaveTextContent('Trigg');
    expect(preview).toHaveTextContent('2/12');
    expect(preview).not.toHaveTextContent('undefined');

    fireEvent.click(screen.getByRole('button', { name: /copiar texto/i }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(clipboardWrite.mock.calls[0]?.[0]).toMatch(/^AGOSTO\/2026/);
    expect(clipboardWrite.mock.calls[0]?.[0]).not.toContain('```');
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Relatório copiado');
  });

  it('invalidates stale output when the month changes and resets after closing', async () => {
    server.use(http.get(`${TRPC_TEST_URL}/familyLoan.getMonthlyTotal`, () => response(monthly())));
    renderDialog(<TestHarness />);

    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }));
    await screen.findByText(/JULHO\/2026/);
    expect(screen.getByRole('button', { name: /copiar texto/i })).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/mês do relatório/i), {
      target: { value: '2026-08' },
    });
    expect(screen.queryByText(/JULHO\/2026/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copiar texto/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^fechar$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^abrir$/i }));
    expect(screen.getByLabelText(/mês do relatório/i)).toHaveValue('2026-07');
    expect(screen.getByRole('button', { name: /copiar texto/i })).toBeDisabled();
  });

  it('reports invalid periods without sending a request', () => {
    const handler = vi.fn();
    server.use(http.get(`${TRPC_TEST_URL}/familyLoan.getMonthlyTotal`, handler));
    renderDialog(<TestHarness />);

    fireEvent.change(screen.getByLabelText(/mês do relatório/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/escolha um mês válido/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses a safe card fallback and handles copy failure', async () => {
    clipboardWrite.mockRejectedValueOnce(new Error('denied'));
    server.use(
      http.get(`${TRPC_TEST_URL}/familyLoan.getMonthlyTotal`, () =>
        response(
          monthly({
            installments: 0,
            oneTimeCharges: 0,
            borrowedCardTotal: 15,
            discounts: 0,
            subtotal: 15,
            total: 15,
            items: { installments: [], fixedCharges: [], expenses: [], discounts: [] },
            borrowedCardBreakdown: [{ creditCardAccountId: CARD_ID, total: 15 }],
          }),
        ),
      ),
    );
    renderDialog(<TestHarness cardNameMap={new Map()} />);

    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }));
    expect(await screen.findByText(/Cartão 222222/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /copiar texto/i }));

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Não foi possível copiar o relatório'),
    );
  });

  it('keeps a truly empty month copyable and omits zero-value cards', async () => {
    server.use(
      http.get(`${TRPC_TEST_URL}/familyLoan.getMonthlyTotal`, () =>
        response(
          monthly({
            installments: 0,
            oneTimeCharges: 0,
            borrowedCardTotal: 0,
            discounts: 0,
            subtotal: 0,
            total: 0,
            items: { installments: [], fixedCharges: [], expenses: [], discounts: [] },
            borrowedCardBreakdown: [{ creditCardAccountId: CARD_ID, total: 0 }],
          }),
        ),
      ),
    );
    renderDialog(<TestHarness />);

    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }));

    expect(await screen.findByText(/sem lançamentos neste mês/i)).toBeInTheDocument();
    const preview = screen.getByText(/JULHO\/2026/);
    expect(preview).not.toHaveTextContent('CARTÕES (+)');
    expect(screen.getByRole('button', { name: /copiar texto/i })).toBeEnabled();
  });

  it('shows query errors and keeps copying disabled', async () => {
    server.use(
      http.get(`${TRPC_TEST_URL}/familyLoan.getMonthlyTotal`, () =>
        HttpResponse.json(
          {
            error: {
              json: {
                message: 'Falha de rede',
                code: -32603,
                data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
              },
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderDialog(<TestHarness />);

    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Falha de rede/);
    expect(screen.getByRole('button', { name: /copiar texto/i })).toBeDisabled();
  });
});
