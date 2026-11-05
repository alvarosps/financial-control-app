import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/msw-server';
import { purchaseFixture } from '@/test/purchase-fixture';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { PurchaseReviewSheet } from './PurchaseReviewSheet';

const response = (value: unknown) =>
  HttpResponse.json({ result: { data: superjson.serialize(value) } });
function setup(
  candidates: unknown[] = [],
  extra: {
    purchase?: ReturnType<typeof purchaseFixture>;
    events?: unknown[];
    institutionEvidence?: unknown[];
    relatedPurchases?: unknown[];
  } = {},
) {
  const purchase = extra.purchase ?? purchaseFixture();
  server.use(
    http.get(`${TRPC_TEST_URL}/purchaseInbox.detail`, () =>
      response({
        purchase,
        events: extra.events ?? [],
        candidates,
        institutionEvidence: extra.institutionEvidence ?? [],
        relatedPurchases: extra.relatedPurchases ?? [],
      }),
    ),
    http.get(`${TRPC_TEST_URL}/account.list`, () =>
      response([
        { id: purchase.cardAccountId, name: 'Cartão local', type: 'credit_card', isActive: true },
        {
          id: '00000000-0000-4000-8000-000000000004',
          name: 'Despesas',
          type: 'expense',
          isActive: true,
        },
      ]),
    ),
    http.get(`${TRPC_TEST_URL}/category.list`, () => response([])),
    http.get(`${TRPC_TEST_URL}/creditCard.listConfigs`, () =>
      response([{ accountId: purchase.cardAccountId, closingDay: 24 }]),
    ),
  );
  const close = vi.fn();
  renderWithProviders(
    <TRPCTestProvider>
      <PurchaseReviewSheet purchaseId={purchase.id} onClose={close} />
    </TRPCTestProvider>,
  );
  return { purchase, close };
}
describe('PurchaseReviewSheet', () => {
  it('prefers institutional cycles and requires reviewing a changed-ID relation before creating another purchase', async () => {
    setup([], {
      institutionEvidence: [
        {
          movementId: 'bank',
          installmentNumber: 1,
          cardLastFour: '1234',
          cycle: {
            billingMonth: 8,
            billingYear: 2026,
            closingDate: '2026-08-24',
            dueDate: '2026-09-08',
          },
          cycleIssue: false,
        },
      ],
      relatedPurchases: [
        {
          observationId: 'other',
          description: 'Compra anterior',
          amount: '100.00',
          currency: 'BRL',
          sameInstitutionalReference: true,
        },
      ],
    });
    expect(await screen.findByText(/Compra anterior/)).toBeInTheDocument();
    expect(screen.getByLabelText('Mês de fechamento da fatura')).toHaveValue('2026-08');
    expect(screen.getByRole('button', { name: 'Registrar compra' })).toBeDisabled();
  });
  it('shows the selected card and amount meaning as labels before opening any menu', async () => {
    setup();
    await screen.findByLabelText('Valor observado');
    expect(
      screen.getByRole('combobox', { name: 'O que este valor representa?' }),
    ).toHaveTextContent('Valor de uma parcela');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Cartão' })).toHaveTextContent('Cartão local'),
    );
  });
  it('distinguishes equal-value candidates by ledger date, cycle and installment', async () => {
    setup(
      [1, 2].map((number) => ({
        transactionId: `00000000-0000-4000-8000-00000000000${number + 5}`,
        scheduleId: null,
        description: 'Coffee',
        amount: '100.00',
        billingMonth: 8 + number,
        billingYear: 2026,
        installmentNumber: number,
        totalInstallments: 3,
        date: new Date(`2026-${number === 1 ? '09' : '10'}-20T00:00:00Z`),
        suggested: number === 1,
      })),
    );
    expect(
      await screen.findByRole('button', {
        name: /Associar a Coffee.*20\/09\/2026.*09\/2026.*1\/3/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Associar a Coffee.*20\/10\/2026.*10\/2026.*2\/3/ }),
    ).toBeInTheDocument();
  });
  it('shows changed source values and separates mistaken evidence without unlinking the ledger', async () => {
    const separated: unknown[] = [];
    server.use(
      http.post(`${TRPC_TEST_URL}/purchaseInbox.separateEvidence`, async ({ request }) => {
        separated.push(await request.json());
        return response(purchaseFixture());
      }),
    );
    const purchase = purchaseFixture({
      review: 'needs_review',
      application: 'created',
      appliedAmount: '300.00',
    });
    const data = {
      ...purchase,
      amount: '120.00',
      description: 'Notebook atualizado',
      confirmation: 'posted',
    };
    const { close } = setup([], {
      purchase,
      events: [
        {
          id: '00000000-0000-4000-8000-000000000020',
          source: 'manual',
          currentVersion: 1,
          revisions: [],
        },
        {
          id: '00000000-0000-4000-8000-000000000021',
          source: 'pdf',
          currentVersion: 2,
          revisions: [
            {
              id: 'revision-2',
              sourceVersion: 2,
              receivedAt: new Date('2026-09-26T15:00:00Z'),
              data,
            },
          ],
        },
      ],
    });
    expect(await screen.findByText('Notebook atualizado')).toBeVisible();
    expect(screen.getByText(/120,00/)).toBeVisible();
    expect(screen.getByText(/diverge dos dados revisados/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Separar evidência de PDF' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(separated[0]).toMatchObject({
      json: {
        observationId: purchase.id,
        version: 1,
        eventId: '00000000-0000-4000-8000-000000000021',
      },
    });
  });
  it('explains offline state and prevents submitting a financial action until connected', async () => {
    setup();
    await screen.findByLabelText('Valor observado');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fireEvent(window, new Event('offline'));
    expect(await screen.findByText(/Você está offline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Registrar compra' })).toBeDisabled();
    online.mockReturnValue(true);
    fireEvent(window, new Event('online'));
    online.mockRestore();
  });
  it('links a candidate using its explicit ID and read version without creating another purchase', async () => {
    const linked: unknown[] = [];
    server.use(
      http.post(`${TRPC_TEST_URL}/purchaseInbox.link`, async ({ request }) => {
        linked.push(await request.json());
        return response(purchaseFixture({ application: 'linked', version: 2 }));
      }),
    );
    const { close } = setup([
      {
        transactionId: '00000000-0000-4000-8000-000000000009',
        scheduleId: null,
        description: 'Notebook existente',
        amount: '100.00',
        billingMonth: 9,
        billingYear: 2026,
        suggested: true,
        date: new Date('2026-09-26'),
      },
    ]);
    await screen.findByRole('dialog');
    fireEvent.click(await screen.findByRole('button', { name: /Associar.*Notebook existente/ }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(linked[0]).toMatchObject({
      json: { version: 1, target: { transactionId: '00000000-0000-4000-8000-000000000009' } },
    });
  });
  it('saves corrections before applying, keeps errors reviewable and offers bank guidance for an unrecognized purchase', async () => {
    const reviews: Array<{ json?: Record<string, unknown> }> = [];
    const accepts: unknown[] = [];
    server.use(
      http.post(`${TRPC_TEST_URL}/purchaseInbox.review`, async ({ request }) => {
        reviews.push((await request.json()) as { json?: Record<string, unknown> });
        return response(purchaseFixture({ version: 2, amount: '90.00' }));
      }),
      http.post(`${TRPC_TEST_URL}/purchaseInbox.accept`, async ({ request }) => {
        accepts.push(await request.json());
        return HttpResponse.error();
      }),
    );
    setup();
    await screen.findByLabelText('Valor observado');
    fireEvent.change(screen.getByLabelText('Valor observado'), { target: { value: '90,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar compra' }));
    await screen.findByRole('alert');
    expect(reviews[0]).toMatchObject({ json: { version: 1, changes: { amount: '90.00' } } });
    expect(accepts[0]).toMatchObject({ json: { version: 2 } });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Não reconheço esta compra' }));
    expect(await screen.findByText(/Confira a compra no aplicativo do banco/)).toBeInTheDocument();
  });
  it('keeps keyboard focus in the sheet and closes with Escape', async () => {
    const user = userEvent.setup();
    const { close } = setup();
    const dialog = await screen.findByRole('dialog');
    await screen.findByLabelText('Valor observado');
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(close).toHaveBeenCalled());
  });
});
