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
import { BulkImportFaturaDialog } from '../BulkImportFaturaDialog';

const TRPC_URL = 'http://localhost:3000/api/trpc';
const cards = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Nubank', profile: 'nubank' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Itaú', profile: 'itau' },
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

describe('BulkImportFaturaDialog', () => {
  it('selects cards in display order and creates drafts from the pasted response', async () => {
    const promptCalls: Record<string, unknown>[] = [];
    const uploadCalls: Array<{ json?: Record<string, unknown> }> = [];
    const onDraftsReady = vi.fn();
    server.use(
      http.get(`${TRPC_URL}/faturaImport.bulkManualPrompt`, async ({ request }) => {
        const input = new URL(request.url).searchParams.get('input');
        promptCalls.push(
          input === null
            ? {}
            : (superjson.deserialize(JSON.parse(input)) as Record<string, unknown>),
        );
        return HttpResponse.json({
          result: { data: superjson.serialize({ prompt: 'PROMPT EM LOTE' }) },
        });
      }),
      http.post(`${TRPC_URL}/faturaImport.uploadManualBulk`, async ({ request }) => {
        uploadCalls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({
          result: {
            data: superjson.serialize([
              { reference: 'card-1', cardAccountId: cards[0].id, importId: 'draft-1' },
              { reference: 'card-2', cardAccountId: cards[1].id, error: 'JSON inválido' },
            ]),
          },
        });
      }),
    );

    render(
      <BulkImportFaturaDialog
        open={true}
        onOpenChange={() => {}}
        cards={cards}
        onDraftsReady={onDraftsReady}
      />,
      { wrapper: TestWrapper },
    );

    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Nubank/));
    fireEvent.click(screen.getByLabelText(/Itaú/));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    await waitFor(() => expect(promptCalls).toHaveLength(1));
    expect(promptCalls[0]).toEqual({ cardAccountIds: cards.map((card) => card.id) });
    expect(await screen.findByDisplayValue('PROMPT EM LOTE')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Resposta JSON'), {
      target: { value: '{"statements":[]}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunhos' }));
    await waitFor(() => expect(uploadCalls).toHaveLength(1));
    expect(uploadCalls[0]?.json).toEqual({
      cardAccountIds: cards.map((card) => card.id),
      provider: 'claude',
      responseJson: '{"statements":[]}',
    });
    await waitFor(() =>
      expect(onDraftsReady).toHaveBeenCalledWith([
        { importId: 'draft-1', cardAccountId: cards[0].id, cardName: 'Nubank' },
      ]),
    );
    expect(screen.getByText('JSON inválido')).toBeVisible();
  });
});
