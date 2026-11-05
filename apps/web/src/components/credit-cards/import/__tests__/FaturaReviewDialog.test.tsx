import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ptMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../../test/msw-server';
import { FaturaReviewDialog } from '../FaturaReviewDialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));

const TRPC_URL = 'http://localhost:3000/api/trpc';
const IMPORT_ID = '11111111-1111-4111-8111-111111111111';
const EXPENSE_ID = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

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

afterEach(() => vi.restoreAllMocks());

describe('FaturaReviewDialog', () => {
  it('keeps the system amount when the reviewer explicitly rejects the document price', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              id: IMPORT_ID,
              status: 'draft',
              billingMonth: 7,
              billingYear: 2026,
              dueDate: '2026-07-15',
              profileId: 'generic',
              modelUsed: 'manual',
              statedTotal: '20.00',
              itemsJson: {
                cardAccounts: [],
                matchResult: {
                  matched: [],
                  missingInSystem: [],
                  newOnFatura: [],
                  review: [
                    {
                      expected: {
                        transactionId: EXPENSE_ID,
                        cardAccountId: ACCOUNT_ID,
                        scheduleId: SCHEDULE_ID,
                        description: 'Subscription',
                        amountBRL: '20.00',
                        domainType: 'credit_card_fixed_charge',
                        installmentNumber: null,
                        totalInstallments: null,
                      },
                      parsed: {
                        description: 'Subscription',
                        amountBRL: '25.00',
                        isRefund: false,
                        installmentCurrent: null,
                        installmentTotal: null,
                      },
                      reasons: ['assinatura_preco'],
                    },
                  ],
                },
                suggestions: [],
                totals: {
                  chargesTotal: '25.00',
                  refundsTotal: '0.00',
                  netTotal: '25.00',
                  delta: '5.00',
                },
              },
            }),
          },
        }),
      ),
      http.post(`${TRPC_URL}/faturaImport.applyDraft`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: IMPORT_ID }) } });
      }),
    );
    const { rerender } = render(
      <FaturaReviewDialog
        importId={IMPORT_ID}
        open
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
      { wrapper: TestWrapper },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Manter sistema' }));
    const acknowledgement = screen.queryByRole('checkbox');
    if (acknowledgement) fireEvent.click(acknowledgement);
    if (!(screen.getByLabelText(ptMessages.statement.confirmPeriod) as HTMLInputElement).checked)
      fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    fireEvent.click(screen.getByRole('button', { name: /Aplicar/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.json).toMatchObject({ decisions: [{ kind: 'skip' }] });
    rerender(
      <FaturaReviewDialog
        importId="55555555-5555-4555-8555-555555555555"
        open
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
    );
    await screen.findByRole('button', { name: 'Manter sistema' });
    fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    expect(screen.getByRole('button', { name: /Aplicar/ })).toBeDisabled();
  });
  it('names the selected additional card and keeps distinct same-value purchases when removing an unrelated item', async () => {
    const additionalId = '55555555-5555-4555-8555-555555555555';
    const purchases = [3, 4].map((day) => ({
      description: 'HOSPITAL',
      amountBRL: '50.00',
      purchaseDate: `2026-07-0${day}`,
      installmentCurrent: null,
      installmentTotal: null,
      isRefund: false,
      cardLastFour: '1234',
      holderName: 'Test Holder',
      isAdditional: true,
    }));
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              id: IMPORT_ID,
              profileId: 'c6',
              billingMonth: 7,
              billingYear: 2026,
              modelUsed: 'manual-claude',
              dueDate: '2026-07-15',
              statedTotal: '100.00',
              itemsJson: {
                cardAccounts: [
                  { id: ACCOUNT_ID, name: 'Principal', parentAccountId: null },
                  { id: additionalId, name: 'Adicional Teste', parentAccountId: ACCOUNT_ID },
                ],
                matchResult: {
                  matched: [],
                  review: [],
                  newOnFatura: purchases,
                  missingInSystem: [
                    {
                      transactionId: EXPENSE_ID,
                      cardAccountId: additionalId,
                      scheduleId: SCHEDULE_ID,
                      description: 'Anuidade Diferenciada',
                      amountBRL: '50.00',
                      date: '2026-07-01',
                      domainType: 'credit_card_installment',
                      installmentNumber: 7,
                      totalInstallments: 12,
                      isPaid: false,
                    },
                  ],
                },
                suggestions: purchases.map((parsed) => ({
                  parsed,
                  suggestedKind: 'add_expense',
                  looksRecurring: false,
                  targetCardAccountId: additionalId,
                })),
                reversalBundles: [],
                blockedGroups: [],
                totals: {
                  chargesTotal: '100.00',
                  refundsTotal: '0.00',
                  netTotal: '100.00',
                  delta: '0.00',
                },
              },
            }),
          },
        }),
      ),
      http.post(`${TRPC_URL}/faturaImport.applyDraft`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: IMPORT_ID }) } });
      }),
    );
    render(
      <FaturaReviewDialog
        importId={IMPORT_ID}
        open
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
      { wrapper: TestWrapper },
    );

    const selectedCards = await screen.findAllByText('Adicional Teste');
    expect(selectedCards).toHaveLength(2);
    for (const selectedCard of selectedCards) expect(selectedCard).toBeVisible();
    expect(screen.queryByText(additionalId)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('No sistema mas fora da fatura (1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Remover do sistema' }));
    if (!(screen.getByLabelText(ptMessages.statement.confirmPeriod) as HTMLInputElement).checked)
      fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar 3 mudanças' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.json).toMatchObject({
      acknowledgeTotalMismatch: false,
      decisions: [
        ...[0, 1].map((suggestionIndex) => ({
          kind: 'add_expense',
          suggestionIndex,
          targetCardAccountId: additionalId,
          amount: '50.00',
        })),
        { kind: 'resolve_missing_item', transactionId: EXPENSE_ID, action: 'remove' },
      ],
    });
  });

  it('shows loading and error feedback when the draft cannot be loaded', async () => {
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, () =>
        HttpResponse.json(
          {
            error: {
              json: {
                message: 'Falha controlada ao carregar',
                code: -32603,
                data: {
                  code: 'INTERNAL_SERVER_ERROR',
                  httpStatus: 500,
                  path: 'faturaImport.get',
                },
              },
            },
          },
          { status: 500 },
        ),
      ),
    );

    render(
      <FaturaReviewDialog
        importId={IMPORT_ID}
        open={true}
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
      { wrapper: TestWrapper },
    );

    expect(screen.getByRole('status')).toHaveTextContent('Carregando...');
    expect(await screen.findByRole('alert')).toHaveTextContent('Falha controlada ao carregar');
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
  });

  it.each([
    'Aceitar fatura',
    'Manter sistema',
  ])('honors the one-time expense decision when choosing %s', async (choice) => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    const onComplete = vi.fn();
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              id: IMPORT_ID,
              profileId: 'itau',
              billingMonth: 7,
              billingYear: 2026,
              modelUsed: 'claude-sonnet-5',
              dueDate: '2026-07-10',
              statedTotal: '45.00',
              itemsJson: {
                matchResult: {
                  matched: [],
                  review: [
                    {
                      parsed: {
                        description: 'Mercado',
                        amountBRL: '45.00',
                        purchaseDate: null,
                        installmentCurrent: null,
                        installmentTotal: null,
                        isRefund: false,
                        cardLastFour: null,
                        holderName: null,
                        isAdditional: false,
                      },
                      expected: {
                        transactionId: EXPENSE_ID,
                        scheduleId: SCHEDULE_ID,
                        description: 'Mercado',
                        amountBRL: '44.90',
                        date: '2026-07-01',
                        domainType: 'credit_card_expense',
                        installmentNumber: null,
                        totalInstallments: null,
                      },
                      reasons: ['valor_aproximado'],
                    },
                  ],
                  newOnFatura: [],
                  missingInSystem: [],
                },
                suggestions: [],
                totals: {
                  chargesTotal: '45.00',
                  refundsTotal: '0.00',
                  netTotal: '45.00',
                  delta: '0.00',
                },
              },
            }),
          },
        }),
      ),
      http.post(`${TRPC_URL}/faturaImport.applyDraft`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: IMPORT_ID }) } });
      }),
    );

    render(
      <FaturaReviewDialog
        importId={IMPORT_ID}
        open={true}
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
        onComplete={onComplete}
      />,
      { wrapper: TestWrapper },
    );

    await screen.findByRole('button', { name: choice });
    fireEvent.click(screen.getByRole('button', { name: choice }));
    if (!(screen.getByLabelText(ptMessages.statement.confirmPeriod) as HTMLInputElement).checked)
      fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    if (choice === 'Manter sistema')
      fireEvent.click(
        screen.getByLabelText(
          ptMessages['components-credit-cards-import-faturareviewdialog'].acknowledgeTotalMismatch,
        ),
      );
    fireEvent.click(screen.getByRole('button', { name: /^Aplicar/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.json).toMatchObject({
      importId: IMPORT_ID,
      expenseAccountId: ACCOUNT_ID,
      reviewedPeriod: { month: 7, year: 2026 },
      decisions:
        choice === 'Manter sistema'
          ? [{ kind: 'skip' }]
          : [{ kind: 'update_expense', transactionId: EXPENSE_ID, amount: '45.00' }],
    });
    expect(onComplete).toHaveBeenCalledWith('applied');
  });

  it('requires and submits an explicit cancellation decision', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              id: IMPORT_ID,
              profileId: 'mercadopago',
              billingMonth: 7,
              billingYear: 2026,
              modelUsed: 'manual-claude',
              dueDate: '2026-07-06',
              statedTotal: '-207.46',
              itemsJson: {
                cardAccounts: [{ id: ACCOUNT_ID, name: 'Mercado Pago', parentAccountId: null }],
                matchResult: {
                  matched: [],
                  review: [],
                  newOnFatura: [],
                  missingInSystem: [],
                },
                suggestions: [],
                reversalBundles: [
                  {
                    charges: Array.from({ length: 11 }, (_, index) => ({
                      description: 'MERCADOLIVREMERCADOLI',
                      amountBRL: '207.37',
                      purchaseDate: '2026-05-20',
                      installmentCurrent: index + 2,
                      installmentTotal: 12,
                      isRefund: false,
                      cardLastFour: '0089',
                      holderName: 'ALVARO SOUZA',
                      isAdditional: false,
                    })),
                    refund: {
                      description: 'CREDITO CONCEDIDO',
                      amountBRL: '2488.53',
                      purchaseDate: '2026-06-30',
                      installmentCurrent: null,
                      installmentTotal: null,
                      isRefund: true,
                      cardLastFour: '0089',
                      holderName: 'ALVARO SOUZA',
                      isAdditional: false,
                    },
                    expected: {
                      transactionId: EXPENSE_ID,
                      cardAccountId: ACCOUNT_ID,
                      scheduleId: SCHEDULE_ID,
                      description: 'MERCADOLIVRE*MERCADOLI',
                      amountBRL: '207.46',
                      date: '2026-07-01',
                      domainType: 'credit_card_installment',
                      installmentNumber: 2,
                      totalInstallments: 12,
                    },
                    chargesTotalBRL: '2281.07',
                    creditTotalBRL: '2488.53',
                    netRefundBRL: '207.46',
                  },
                ],
                blockedGroups: [],
                totals: {
                  chargesTotal: '2281.07',
                  refundsTotal: '2488.53',
                  netTotal: '-207.46',
                  delta: '0.00',
                },
              },
            }),
          },
        }),
      ),
      http.post(`${TRPC_URL}/faturaImport.applyDraft`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: IMPORT_ID }) } });
      }),
    );

    render(
      <FaturaReviewDialog
        importId={IMPORT_ID}
        open={true}
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
      { wrapper: TestWrapper },
    );

    const applyButton = await screen.findByRole('button', { name: 'Aplicar 0 mudanças' });
    expect(applyButton).toBeDisabled();
    if (!(screen.getByLabelText(ptMessages.statement.confirmPeriod) as HTMLInputElement).checked)
      fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar cancelamento' }));
    if (!(screen.getByLabelText(ptMessages.statement.confirmPeriod) as HTMLInputElement).checked)
      fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar 1 mudanças' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.json).toMatchObject({
      decisions: [{ kind: 'resolve_reversal_bundle', bundleIndex: 0, action: 'apply' }],
      acknowledgeTotalMismatch: false,
    });
  });

  it('blocks applying ambiguous repeated installment groups', async () => {
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              id: IMPORT_ID,
              profileId: 'mercadopago',
              billingMonth: 7,
              billingYear: 2026,
              modelUsed: 'manual-claude',
              dueDate: '2026-07-06',
              statedTotal: '414.74',
              itemsJson: {
                cardAccounts: [{ id: ACCOUNT_ID, name: 'Mercado Pago', parentAccountId: null }],
                matchResult: {
                  matched: [],
                  review: [],
                  newOnFatura: [],
                  missingInSystem: [],
                },
                suggestions: [],
                reversalBundles: [],
                blockedGroups: [
                  {
                    reason: 'multiple_installments_same_purchase',
                    items: Array.from({ length: 2 }, (_, index) => ({
                      description: 'MERCADOLIVREMERCADOLI',
                      amountBRL: '207.37',
                      purchaseDate: '2026-05-20',
                      installmentCurrent: index + 2,
                      installmentTotal: 12,
                      isRefund: false,
                      cardLastFour: '0089',
                      holderName: 'ALVARO SOUZA',
                      isAdditional: false,
                    })),
                  },
                ],
                totals: {
                  chargesTotal: '414.74',
                  refundsTotal: '0.00',
                  netTotal: '414.74',
                  delta: '0.00',
                },
              },
            }),
          },
        }),
      ),
    );

    render(
      <FaturaReviewDialog
        importId={IMPORT_ID}
        open={true}
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
      { wrapper: TestWrapper },
    );

    expect(
      await screen.findByText('Este rascunho não pode ser aplicado com segurança.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Aplicar 0 mudanças' })).toBeDisabled();
  });

  it('shows type and installment details and submits keep/remove decisions for missing items', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    const installmentTransactionId = '55555555-5555-4555-8555-555555555555';
    const oneTimeTransactionId = '77777777-7777-4777-8777-777777777777';
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              id: IMPORT_ID,
              profileId: 'brb',
              billingMonth: 7,
              billingYear: 2026,
              modelUsed: 'manual-claude',
              dueDate: '2026-07-08',
              statedTotal: '37.93',
              itemsJson: {
                cardAccounts: [{ id: ACCOUNT_ID, name: 'BRB', parentAccountId: null }],
                matchResult: {
                  matched: [],
                  review: [],
                  newOnFatura: [],
                  missingInSystem: [
                    {
                      transactionId: EXPENSE_ID,
                      cardAccountId: ACCOUNT_ID,
                      scheduleId: SCHEDULE_ID,
                      description: 'Globoplay',
                      amountBRL: '27.93',
                      date: '2026-07-01',
                      domainType: 'credit_card_fixed_charge',
                      installmentNumber: null,
                      totalInstallments: null,
                      isPaid: false,
                    },
                    {
                      transactionId: installmentTransactionId,
                      cardAccountId: ACCOUNT_ID,
                      scheduleId: '66666666-6666-4666-8666-666666666666',
                      description: 'Compra incorreta',
                      amountBRL: '88.37',
                      date: '2026-07-01',
                      domainType: 'credit_card_installment',
                      installmentNumber: 2,
                      totalInstallments: 12,
                      isPaid: false,
                    },
                    {
                      transactionId: oneTimeTransactionId,
                      cardAccountId: ACCOUNT_ID,
                      scheduleId: null,
                      description: 'Compra avulsa mantida',
                      amountBRL: '10.00',
                      date: '2026-07-02',
                      domainType: 'credit_card_expense',
                      installmentNumber: null,
                      totalInstallments: null,
                      isPaid: false,
                    },
                  ],
                },
                suggestions: [],
                reversalBundles: [],
                blockedGroups: [],
                totals: {
                  chargesTotal: '0.00',
                  refundsTotal: '0.00',
                  netTotal: '0.00',
                  delta: '-37.93',
                },
              },
            }),
          },
        }),
      ),
      http.post(`${TRPC_URL}/faturaImport.applyDraft`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: IMPORT_ID }) } });
      }),
    );

    render(
      <FaturaReviewDialog
        importId={IMPORT_ID}
        open={true}
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
      { wrapper: TestWrapper },
    );

    const applyButton = await screen.findByRole('button', { name: 'Aplicar 0 mudanças' });
    expect(applyButton).toBeDisabled();
    fireEvent.click(screen.getByText('No sistema mas fora da fatura (3)'));
    expect(screen.getByText('Cobrança fixa')).toBeVisible();
    expect(screen.getByText('2/12')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Manter no sistema' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Remover do sistema' })).toHaveLength(3);

    fireEvent.click(screen.getAllByRole('button', { name: 'Manter no sistema' })[0] as HTMLElement);
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Remover do sistema' })[1] as HTMLElement,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Manter no sistema' })[2] as HTMLElement);
    if (!(screen.getByLabelText(ptMessages.statement.confirmPeriod) as HTMLInputElement).checked)
      fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar 1 mudanças' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.json).toMatchObject({
      decisions: [
        { kind: 'resolve_missing_item', transactionId: EXPENSE_ID, action: 'keep' },
        {
          kind: 'resolve_missing_item',
          transactionId: installmentTransactionId,
          action: 'remove',
        },
        {
          kind: 'resolve_missing_item',
          transactionId: oneTimeTransactionId,
          action: 'keep',
        },
      ],
      acknowledgeTotalMismatch: false,
    });
  });

  it('links a new statement entry to an existing fixed charge without adding a duplicate', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              id: IMPORT_ID,
              profileId: 'azul',
              billingMonth: 7,
              billingYear: 2026,
              modelUsed: 'manual-claude',
              dueDate: '2026-07-15',
              statedTotal: '117.15',
              itemsJson: {
                cardAccounts: [{ id: ACCOUNT_ID, name: 'Azul', parentAccountId: null }],
                matchResult: {
                  matched: [],
                  review: [],
                  newOnFatura: [],
                  missingInSystem: [
                    {
                      transactionId: EXPENSE_ID,
                      cardAccountId: ACCOUNT_ID,
                      scheduleId: SCHEDULE_ID,
                      description: 'Claude Pro Camila',
                      amountBRL: '116.00',
                      date: '2026-07-01',
                      domainType: 'credit_card_fixed_charge',
                      installmentNumber: null,
                      totalInstallments: null,
                      isPaid: false,
                    },
                  ],
                },
                suggestions: [
                  {
                    parsed: {
                      description: 'ANTHROPIC* CLAUDE SUB',
                      amountBRL: '117.15',
                      purchaseDate: '2026-07-05',
                      installmentCurrent: null,
                      installmentTotal: null,
                      isRefund: false,
                      cardLastFour: '1551',
                      holderName: 'CAMILA STEINMETZ',
                      isAdditional: true,
                    },
                    suggestedKind: 'add_fixed_charge',
                    looksRecurring: true,
                    targetCardAccountId: ACCOUNT_ID,
                  },
                ],
                reversalBundles: [],
                blockedGroups: [],
                totals: {
                  chargesTotal: '117.15',
                  refundsTotal: '0.00',
                  netTotal: '117.15',
                  delta: '0.00',
                },
              },
            }),
          },
        }),
      ),
      http.post(`${TRPC_URL}/faturaImport.applyDraft`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: IMPORT_ID }) } });
      }),
    );
    const user = userEvent.setup();

    render(
      <FaturaReviewDialog
        importId={IMPORT_ID}
        open={true}
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
      { wrapper: TestWrapper },
    );

    await screen.findByDisplayValue('ANTHROPIC* CLAUDE SUB (CAMILA)');
    await user.click(screen.getByText('No sistema mas fora da fatura (1)'));
    await user.click(screen.getByText('Vincular a um item da fatura'));
    await user.click(
      await screen.findByRole('option', {
        name: /ANTHROPIC\* CLAUDE SUB.*R\$ 117,15/i,
      }),
    );

    expect(screen.getByText('Vinculado ao sistema')).toBeVisible();
    if (!(screen.getByLabelText(ptMessages.statement.confirmPeriod) as HTMLInputElement).checked)
      fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    await user.click(screen.getByRole('button', { name: 'Aplicar 1 mudanças' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.json).toMatchObject({
      decisions: [
        {
          kind: 'link_statement_item',
          suggestionIndex: 0,
          transactionId: EXPENSE_ID,
        },
      ],
      acknowledgeTotalMismatch: false,
    });
  });

  it('links a statement refund to an existing refund outside the statement', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              id: IMPORT_ID,
              profileId: 'azul',
              billingMonth: 7,
              billingYear: 2026,
              modelUsed: 'manual-claude',
              dueDate: '2026-07-15',
              statedTotal: '-52.50',
              itemsJson: {
                cardAccounts: [{ id: ACCOUNT_ID, name: 'Azul', parentAccountId: null }],
                matchResult: {
                  matched: [],
                  review: [],
                  newOnFatura: [],
                  missingInSystem: [
                    {
                      transactionId: EXPENSE_ID,
                      cardAccountId: ACCOUNT_ID,
                      scheduleId: SCHEDULE_ID,
                      description: 'Estorno Anuidade Diferenciada',
                      amountBRL: '105.00',
                      date: '2026-07-01',
                      domainType: 'credit_card_refund',
                      installmentNumber: null,
                      totalInstallments: null,
                      isPaid: false,
                    },
                  ],
                },
                suggestions: [
                  {
                    parsed: {
                      description: 'ESTORNO DE ANUIDADE DIF',
                      amountBRL: '52.50',
                      purchaseDate: '2026-07-05',
                      installmentCurrent: null,
                      installmentTotal: null,
                      isRefund: true,
                      cardLastFour: '5214',
                      holderName: 'ALVARO SOUZA',
                      isAdditional: false,
                    },
                    suggestedKind: 'add_refund',
                    looksRecurring: false,
                    targetCardAccountId: ACCOUNT_ID,
                  },
                ],
                reversalBundles: [],
                blockedGroups: [],
                totals: {
                  chargesTotal: '0.00',
                  refundsTotal: '52.50',
                  netTotal: '-52.50',
                  delta: '0.00',
                },
              },
            }),
          },
        }),
      ),
      http.post(`${TRPC_URL}/faturaImport.applyDraft`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: IMPORT_ID }) } });
      }),
    );
    const user = userEvent.setup();

    render(
      <FaturaReviewDialog
        importId={IMPORT_ID}
        open={true}
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
      { wrapper: TestWrapper },
    );

    await screen.findByDisplayValue('ESTORNO DE ANUIDADE DIF');
    await user.click(screen.getByText('No sistema mas fora da fatura (1)'));
    await user.click(screen.getByText('Vincular a um item da fatura'));
    await user.click(
      await screen.findByRole('option', {
        name: /ESTORNO DE ANUIDADE DIF.*R\$ 52,50/i,
      }),
    );

    expect(screen.getByText('Vinculado ao sistema')).toBeVisible();
    if (!(screen.getByLabelText(ptMessages.statement.confirmPeriod) as HTMLInputElement).checked)
      fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    await user.click(screen.getByRole('button', { name: 'Aplicar 1 mudanças' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.json).toMatchObject({
      decisions: [
        {
          kind: 'link_statement_item',
          suggestionIndex: 0,
          transactionId: EXPENSE_ID,
        },
      ],
      acknowledgeTotalMismatch: false,
    });
  });

  it('ignores zero-value suggestions from legacy drafts', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              id: IMPORT_ID,
              profileId: 'leroy-merlin',
              billingMonth: 7,
              billingYear: 2026,
              modelUsed: 'manual-claude',
              dueDate: '2026-07-13',
              statedTotal: '0.00',
              itemsJson: {
                cardAccounts: [{ id: ACCOUNT_ID, name: 'Leroy Merlin', parentAccountId: null }],
                matchResult: {
                  matched: [],
                  review: [],
                  newOnFatura: [],
                  missingInSystem: [],
                },
                suggestions: [
                  {
                    parsed: {
                      description: 'ANUIDADE DIFERENCIADA',
                      amountBRL: '0.00',
                      purchaseDate: null,
                      installmentCurrent: null,
                      installmentTotal: null,
                      isRefund: false,
                      cardLastFour: '6122',
                      holderName: 'ALVARO SILVA',
                      isAdditional: false,
                    },
                    suggestedKind: 'add_expense',
                    looksRecurring: false,
                    targetCardAccountId: ACCOUNT_ID,
                  },
                ],
                reversalBundles: [],
                blockedGroups: [],
                totals: {
                  chargesTotal: '0.00',
                  refundsTotal: '0.00',
                  netTotal: '0.00',
                  delta: '0.00',
                },
              },
            }),
          },
        }),
      ),
      http.post(`${TRPC_URL}/faturaImport.applyDraft`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: IMPORT_ID }) } });
      }),
    );

    render(
      <FaturaReviewDialog
        importId={IMPORT_ID}
        open={true}
        onOpenChange={() => {}}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
      { wrapper: TestWrapper },
    );

    const applyButton = await screen.findByRole('button', { name: /Aplicar/ });
    expect(applyButton).toHaveTextContent(/Aplicar 0/);
    expect(screen.getByRole('combobox')).toBeDisabled();
    if (!(screen.getByLabelText(ptMessages.statement.confirmPeriod) as HTMLInputElement).checked)
      fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    fireEvent.click(applyButton);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.json).toMatchObject({
      decisions: [{ kind: 'skip' }],
      acknowledgeTotalMismatch: false,
    });
  });
});
