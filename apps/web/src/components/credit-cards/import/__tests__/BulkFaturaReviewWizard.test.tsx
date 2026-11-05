import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpLink } from '@trpc/client';
import { HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import ptMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../../test/msw-server';
import { BulkFaturaReviewWizard } from '../BulkFaturaReviewWizard';

const TRPC_URL = 'http://localhost:3000/api/trpc';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const drafts = [
  {
    importId: '11111111-1111-4111-8111-111111111111',
    cardAccountId: ACCOUNT_ID,
    cardName: 'Nubank',
  },
  { importId: '22222222-2222-4222-8222-222222222222', cardAccountId: ACCOUNT_ID, cardName: 'Itaú' },
];

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const trpcClient = trpc.createClient({
    links: [httpLink({ url: TRPC_URL, transformer: superjson })],
  });
  return (
    <NextIntlClientProvider locale="pt-BR" messages={ptMessages as Record<string, unknown>}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </NextIntlClientProvider>
  );
}

function draftResponse(importId: string) {
  return {
    id: importId,
    billingMonth: 8,
    billingYear: 2026,
    profileId: 'nubank',
    modelUsed: 'manual-bulk-claude',
    dueDate: '2026-08-10',
    statedTotal: '0.00',
    itemsJson: {
      cardAccounts: [],
      matchResult: { matched: [], review: [], newOnFatura: [], missingInSystem: [] },
      suggestions: [],
      reversalBundles: [],
      blockedGroups: [],
      totals: { chargesTotal: '0.00', refundsTotal: '0.00', netTotal: '0.00', delta: '0.00' },
    },
  };
}

describe('BulkFaturaReviewWizard', () => {
  it('advances after applying and closes after skipping the last draft', async () => {
    const onOpenChange = vi.fn();
    server.use(
      http.get(`${TRPC_URL}/faturaImport.get`, ({ request }) => {
        const input = new URL(request.url).searchParams.get('input');
        const value: { importId?: string } =
          input === null
            ? { importId: '' }
            : (superjson.deserialize(JSON.parse(input)) as { importId: string });
        return HttpResponse.json({
          result: {
            data: superjson.serialize(draftResponse(value.importId ?? drafts[0].importId)),
          },
        });
      }),
      http.post(`${TRPC_URL}/faturaImport.applyDraft`, () =>
        HttpResponse.json({ result: { data: superjson.serialize({ id: drafts[0].importId }) } }),
      ),
    );

    render(
      <BulkFaturaReviewWizard
        open={true}
        onOpenChange={onOpenChange}
        drafts={drafts}
        defaultSourceAccountId={ACCOUNT_ID}
      />,
      { wrapper: TestWrapper },
    );

    expect(await screen.findByText('Cartão 1 de 2: Nubank')).toBeVisible();
    fireEvent.click(screen.getByLabelText(ptMessages.statement.confirmPeriod));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar 0 mudanças' }));
    expect(await screen.findByText('Cartão 2 de 2: Itaú')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Pular' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
