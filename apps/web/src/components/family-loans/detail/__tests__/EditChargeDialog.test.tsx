import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { toast } from 'sonner';
import superjson, { type SuperJSONResult } from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderDialog } from '@/test/dialog';
import { server } from '@/test/msw-server';
import { EditChargeDialog, type EditChargeTarget } from '../EditChargeDialog';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

const TRPC_URL = 'http://localhost:3000/api/trpc';
const SCHEDULE_ID = '22222222-2222-2222-2222-222222222222';

const target: EditChargeTarget = {
  scheduledTransactionId: SCHEDULE_ID,
  description: 'Item atual',
  amount: '50.00',
  domainType: 'family_loan_discount',
  installmentNumber: 7,
  totalInstallments: 12,
};

function schedule(overrides: Record<string, unknown>) {
  return {
    id: SCHEDULE_ID,
    userId: '11111111-1111-1111-1111-111111111111',
    sourceAccountId: '33333333-3333-3333-3333-333333333333',
    destinationAccountId: '33333333-3333-3333-3333-333333333333',
    amount: '50.00',
    currency: 'BRL',
    description: 'Item atual',
    categoryId: null,
    frequency: 'once',
    startDate: new Date('2026-07-10T00:00:00.000Z'),
    endDate: null,
    dueDay: null,
    totalOccurrences: null,
    startingOccurrence: 1,
    isActive: true,
    notes: null,
    domainType: 'family_loan_expense',
    domainConfigId: '44444444-4444-4444-4444-444444444444',
    isFixedCharge: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    firstBillingMonth: null,
    firstBillingYear: null,
    ...overrides,
  };
}

function seedSchedule(value: Record<string, unknown>) {
  const response = () => HttpResponse.json({ result: { data: superjson.serialize(value) } });
  server.use(
    http.get(`${TRPC_URL}/scheduled.getById`, response),
    http.post(`${TRPC_URL}/scheduled.getById`, response),
  );
}

function renderEdit(currentTarget: EditChargeTarget = target) {
  return renderDialog(
    <EditChargeDialog
      open
      onOpenChange={() => {}}
      target={currentTarget}
      billMonth={7}
      billYear={2026}
      onSuccess={() => {}}
    />,
  );
}

afterEach(() => vi.clearAllMocks());

describe('FamilyLoan EditChargeDialog', () => {
  it('edits an installment through familyLoan.editInstallment', async () => {
    seedSchedule(
      schedule({
        domainType: 'family_loan_installment',
        frequency: 'monthly',
        totalOccurrences: 12,
        dueDay: 10,
      }),
    );
    const calls: SuperJSONResult[] = [];
    server.use(
      http.post(`${TRPC_URL}/familyLoan.editInstallment`, async ({ request }) => {
        calls.push((await request.json()) as SuperJSONResult);
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    renderEdit({ ...target, domainType: 'family_loan_installment' });

    await waitFor(() => expect(screen.getByLabelText(/parcela atual/i)).toHaveValue(7));
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].json).toMatchObject({
      scheduleId: SCHEDULE_ID,
      amount: '50.00',
      currentInstallment: 7,
      totalInstallments: 12,
      currentBillingMonth: 7,
      currentBillingYear: 2026,
    });
  });

  it('edits a one-time expense with its civil date', async () => {
    seedSchedule(schedule({ domainType: 'family_loan_expense' }));
    const calls: SuperJSONResult[] = [];
    server.use(
      http.post(`${TRPC_URL}/familyLoan.editAdjustment`, async ({ request }) => {
        calls.push((await request.json()) as SuperJSONResult);
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    renderEdit({ ...target, domainType: 'family_loan_expense', installmentNumber: null });

    await waitFor(() => expect(screen.getByLabelText(/data/i)).toHaveValue('2026-07-10'));
    fireEvent.change(screen.getByLabelText(/data/i), { target: { value: '2026-08-15' } });
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    const payload = superjson.deserialize<Record<string, unknown>>(calls[0]);
    expect(payload).toMatchObject({
      scheduleId: SCHEDULE_ID,
      amount: '50.00',
      date: new Date('2026-08-15T12:00:00'),
    });
    expect(payload).not.toHaveProperty('totalInstallments');
  });

  it('anchors an installment discount in the displayed month', async () => {
    seedSchedule(
      schedule({
        domainType: 'family_loan_discount',
        frequency: 'monthly',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        dueDay: 10,
        totalOccurrences: 12,
      }),
    );
    const calls: SuperJSONResult[] = [];
    server.use(
      http.post(`${TRPC_URL}/familyLoan.editAdjustment`, async ({ request }) => {
        calls.push((await request.json()) as SuperJSONResult);
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    renderEdit();

    await waitFor(() => expect(screen.getByLabelText(/data/i)).toHaveValue('2026-07-10'));
    expect(screen.getByLabelText(/desconto parcelado/i)).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].json).toMatchObject({
      scheduleId: SCHEDULE_ID,
      currentInstallment: 7,
      totalInstallments: 12,
      dueDay: 10,
    });
  });

  it('shows a load error and never exposes a submit action', async () => {
    server.use(
      http.get(`${TRPC_URL}/scheduled.getById`, () =>
        HttpResponse.json(
          {
            error: {
              json: {
                message: 'Not found',
                code: -32004,
                data: { code: 'NOT_FOUND', httpStatus: 404, path: 'scheduled.getById' },
              },
            },
          },
          { status: 404 },
        ),
      ),
    );
    renderEdit();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /salvar/i })).not.toBeInTheDocument();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});
