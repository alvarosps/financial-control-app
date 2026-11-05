import { transferableAbortController } from 'node:util';
import { SYSTEM_ACCOUNT_NAMES } from '@fc/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '@/i18n/messages/pt-BR.json';
import { server } from '@/test/msw-server';
import { installHistorySync } from '@/test/next-navigation-fake';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { CreditCardsClient } from './CreditCardsClient';

vi.mock('next/navigation', async () => {
  const fake = await import('@/test/next-navigation-fake');
  return { useSearchParams: fake.useFakeSearchParams };
});

let restoreHistory = () => {};
beforeEach(() => {
  vi.stubGlobal('AbortController', transferableAbortController().constructor);
  restoreHistory = installHistorySync();
  window.history.replaceState(null, '', '/credit-cards?view=closing');
});
afterEach(() => {
  restoreHistory();
  vi.unstubAllGlobals();
});

const cardId = '11111111-1111-4111-8111-111111111111';
const walletId = '22222222-2222-4222-8222-222222222222';
const expenseId = '33333333-3333-4333-8333-333333333333';
const draftId = '44444444-4444-4444-8444-444444444444';
const result = (data: unknown) =>
  HttpResponse.json({ result: { data: superjson.serialize(data) } });

function setup(options: { profile?: boolean; wallets?: boolean } = {}) {
  let paid = false;
  const summaryRead = vi.fn();
  const billRead = vi.fn();
  const payments: unknown[] = [];
  const uploads: unknown[] = [];
  const applies: unknown[] = [];
  server.use(
    http.get(`${TRPC_TEST_URL}/creditCard.getBillSummary`, () => {
      summaryRead();
      return result([
        {
          cardId,
          cardName: 'Cartão Azul',
          color: '#123456',
          canArchive: false,
          archiveBlockedReason: 'CURRENT_BILL',
          currentBill: {
            month: 9,
            year: 2026,
            total: 800,
            unpaidTotal: paid ? 0 : 300,
            isPaid: paid,
            dueDay: 5,
            dueDate: '2026-10-05',
            transactionCount: 2,
          },
          previousBill: null,
          nextBillPreview: { month: 10, year: 2026, total: 250, transactionCount: 1 },
        },
      ]);
    }),
    http.get(`${TRPC_TEST_URL}/creditCard.listConfigs`, () =>
      result([
        {
          accountId: cardId,
          closingDay: 15,
          dueDay: 5,
          creditLimit: '5000.00',
          billParserType: options.profile === false ? null : 'itau',
        },
      ]),
    ),
    http.get(`${TRPC_TEST_URL}/account.list`, () =>
      result([
        {
          id: expenseId,
          name: SYSTEM_ACCOUNT_NAMES.CREDIT_CARD_EXPENSES,
          type: 'expense',
          isActive: true,
        },
        ...(options.wallets === false
          ? []
          : [
              {
                id: walletId,
                name: 'Conta principal',
                type: 'checking',
                currency: 'BRL',
                isActive: true,
              },
            ]),
        { id: 'inactive-wallet', name: 'Conta inativa', type: 'checking', isActive: false },
      ]),
    ),
    http.get(`${TRPC_TEST_URL}/creditCard.getConsolidatedBill`, ({ request }) => {
      billRead(JSON.parse(new URL(request.url).searchParams.get('input') ?? '{}'));
      return result({
        total: 800,
        unpaidTotal: paid ? 0 : 300,
        isPaid: paid,
        transactionCount: 2,
        currency: 'BRL',
        breakdown: [
          { cardId, name: 'Cartão Azul', total: 500, unpaidTotal: 0, isPrincipal: true },
          {
            cardId: 'child-1',
            name: 'Adicional',
            total: 300,
            unpaidTotal: paid ? 0 : 300,
            isPrincipal: false,
          },
        ],
      });
    }),
    http.post(`${TRPC_TEST_URL}/creditCard.payBill`, async ({ request }) => {
      payments.push(await request.json());
      paid = true;
      return result({ billTotal: '300.00', markedCount: 1 });
    }),
    http.post(`${TRPC_TEST_URL}/faturaImport.upload`, async ({ request }) => {
      uploads.push(await request.json());
      return result({ id: draftId });
    }),
    http.get(`${TRPC_TEST_URL}/faturaImport.get`, () =>
      result({
        id: draftId,
        billingMonth: 9,
        billingYear: 2026,
        profileId: 'itau',
        modelUsed: 'test',
        dueDate: '2026-10-05',
        statedTotal: '45.00',
        itemsJson: {
          matchResult: {
            matched: [],
            review: [],
            missingInSystem: [],
            newOnFatura: [
              {
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
            ],
          },
          suggestions: [
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
              suggestedKind: 'add_expense',
              targetCardAccountId: cardId,
            },
          ],
          cardAccounts: [{ id: cardId, name: 'Cartão Azul', parentAccountId: null }],
          totals: { chargesTotal: '45.00', refundsTotal: '0.00', netTotal: '45.00', delta: '0.00' },
        },
      }),
    ),
    http.post(`${TRPC_TEST_URL}/faturaImport.applyDraft`, async ({ request }) => {
      applies.push(await request.json());
      return result({ id: draftId });
    }),
  );
  renderWithProviders(
    <TRPCTestProvider>
      <CreditCardsClient />
    </TRPCTestProvider>,
  );
  return { summaryRead, billRead, payments, uploads, applies };
}

describe('CreditCardsClient bill actions', () => {
  it('pays the displayed period, refetches the list and never clicks the card link', async () => {
    const { billRead, payments, summaryRead } = setup();
    const payButton = await screen.findByRole('button', { name: 'Pagar fatura de Cartão Azul' });
    expect(screen.getByRole('link', { name: 'Compras' })).toHaveAttribute('href', '/purchases');
    expect(payButton.closest('a')).toBeNull();
    expect(billRead).not.toHaveBeenCalled();
    const link = screen.getByRole('link', { name: /Cartão Azul/i });
    const clickedLink = vi.fn();
    link.addEventListener('click', clickedLink);
    payButton.focus();
    fireEvent.click(payButton);
    const dialog = await screen.findByRole('dialog');
    const confirm = await within(dialog).findByRole('button', { name: 'Confirmar' });
    fireEvent.change(await screen.findByLabelText(/Data e hora do pagamento/), {
      target: { value: '2026-09-12T09:00' },
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(within(dialog).getByText(/Total da fatura: R\$ 800,00/)).toBeInTheDocument();
    expect(billRead).toHaveBeenCalledWith({
      json: { cardAccountId: cardId, month: 9, year: 2026 },
    });
    confirm.focus();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(payments).toHaveLength(1));
    expect(payments[0]).toMatchObject({
      json: { cardAccountId: cardId, month: 9, year: 2026, paidFromAccountId: walletId },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(summaryRead.mock.calls.length).toBeGreaterThan(1);
    expect(
      screen.queryByRole('button', { name: 'Pagar fatura de Cartão Azul' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Fatura: Setembro 2026/i)).toBeInTheDocument();
    expect(clickedLink).not.toHaveBeenCalled();
    await waitFor(() => expect(link).toHaveFocus());
  });

  it('opens the selected card import, reviews it and refreshes the list after applying', async () => {
    const { uploads, applies, summaryRead, billRead } = setup();
    const importButton = await screen.findByRole('button', {
      name: 'Atualizar fatura de Cartão Azul',
    });
    importButton.focus();
    fireEvent.click(importButton);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cartão Azul')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(messages.statement.selectPeriod), {
      target: { value: '2026-09' },
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: /automático/i })).toBeEnabled());
    fireEvent.click(screen.getByLabelText(messages.statement.externalConsent));
    fireEvent.change(screen.getByLabelText('PDF da fatura'), {
      target: { files: [new File(['%PDF-1.4'], 'fatura.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: /^importar$/i }));
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toMatchObject({ json: { cardAccountId: cardId, fileName: 'fatura.pdf' } });
    expect(applies).toHaveLength(0);
    fireEvent.click(await screen.findByLabelText(messages.statement.confirmPeriod));
    fireEvent.click(await screen.findByRole('button', { name: /Aplicar 1 mudanças/i }));
    await waitFor(() => expect(applies).toHaveLength(1));
    expect(applies[0]).toMatchObject({ json: { importId: draftId, expenseAccountId: expenseId } });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(summaryRead.mock.calls.length).toBeGreaterThan(1);
    expect(billRead).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Atualizar cartões com faturas' })).toBeEnabled();
    await waitFor(() => expect(importButton).toHaveFocus());
  });

  it('returns focus to the initiating action when payment is cancelled', async () => {
    const { payments } = setup();
    const payButton = await screen.findByRole('button', { name: 'Pagar fatura de Cartão Azul' });
    payButton.focus();
    fireEvent.click(payButton);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(payButton).toHaveFocus());
    expect(payments).toHaveLength(0);
  });

  it('offers profile setup for the selected card when import is unavailable', async () => {
    setup({ profile: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Atualizar fatura de Cartão Azul' }));
    expect(await screen.findByRole('link', { name: /Configurar perfil/i })).toHaveAttribute(
      'href',
      `/credit-cards/${cardId}`,
    );
    expect(screen.getByRole('button', { name: /^importar$/i })).toBeDisabled();
  });

  it('explains the missing payment account without allowing confirmation', async () => {
    const { payments } = setup({ wallets: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Pagar fatura de Cartão Azul' }));
    expect(await screen.findByText(/Nenhuma conta/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
    expect(payments).toHaveLength(0);
  });
});
