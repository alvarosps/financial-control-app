import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { BankReconciliationPanel } from './BankReconciliationPanel';
import { IntegrationSettings } from './ConnectionCard';

const response = (value: unknown) =>
  HttpResponse.json({ result: { data: superjson.serialize(value) } });
const id = '11111111-1111-4111-8111-111111111111';
describe('personal integration settings', () => {
  it('distinguishes institution/fetch times and pauses ingestion while preserving visible accounts', async () => {
    let paused = false;
    server.use(
      http.get(`${TRPC_TEST_URL}/integration.list`, () =>
        response({
          enabled: true,
          configuredItems: [],
          connections: [
            {
              id,
              name: 'Meu banco',
              status: paused ? 'paused' : 'active',
              sourceUpdatedAt: new Date('2026-09-25T15:00:00Z'),
              lastFetchedAt: null,
              errorCode: null,
              accounts: [
                {
                  id,
                  kind: 'BANK',
                  currency: 'BRL',
                  name: 'Itaú',
                  accountId: id,
                  unresolvedCardEvidence: 0,
                },
              ],
              jobs: [],
            },
          ],
        }),
      ),
      http.get(`${TRPC_TEST_URL}/account.list`, () =>
        response([{ id, name: 'Conta local', type: 'checking', currency: 'BRL', isActive: true }]),
      ),
      http.post(`${TRPC_TEST_URL}/integration.pause`, () => {
        paused = true;
        return response(null);
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <IntegrationSettings />
      </TRPCTestProvider>,
    );
    expect(await screen.findByText('Meu banco')).toBeInTheDocument();
    expect(screen.getByText('Última atualização da instituição')).toBeInTheDocument();
    expect(screen.getByText('Última leitura concluída')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pausar conexão' }));
    expect(await screen.findByText('Pausada')).toBeInTheDocument();
    expect(screen.getByText('Itaú')).toBeInTheDocument();
  });
  it('requires full explicit allocations and keeps a failed review open', async () => {
    const submitted: unknown[] = [];
    server.use(
      http.get(`${TRPC_TEST_URL}/integration.bankMovements`, () =>
        response({
          items: [
            {
              id,
              version: 2,
              description: 'Pagamento agregado',
              amount: '150.00',
              currency: 'BRL',
              date: '2026-09-25',
              state: 'pending',
              type: 'DEBIT',
              status: 'POSTED',
              retractedAt: null,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get(`${TRPC_TEST_URL}/integration.balance`, () =>
        response({
          institutional: '-9951.85',
          balanceType: 'unknown',
          asOf: null,
          comparable: false,
          reason: 'unknown_balance_type',
          calculated: null,
          difference: null,
        }),
      ),
      http.get(`${TRPC_TEST_URL}/integration.bankDetail`, () =>
        response({
          id,
          version: 2,
          state: 'pending',
          reviewable: true,
          movement: {
            description: 'Pagamento agregado',
            amount: '150.00',
            currency: 'BRL',
            date: '2026-09-25',
            type: 'DEBIT',
          },
          links: [],
          candidatesTruncated: false,
          candidates: [
            {
              transactionId: 'a',
              fingerprint: 'a'.repeat(64),
              description: 'Principal',
              amount: '100.00',
              date: '2026-09-25',
            },
            {
              transactionId: 'b',
              fingerprint: 'b'.repeat(64),
              description: 'Adicional',
              amount: '50.00',
              date: '2026-09-25',
            },
          ],
        }),
      ),
      http.post(`${TRPC_TEST_URL}/integration.linkBank`, async ({ request }) => {
        submitted.push(await request.json());
        return HttpResponse.error();
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <BankReconciliationPanel externalAccountId={id} />
      </TRPCTestProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Revisar Pagamento agregado/ }));
    const confirm = await screen.findByRole('button', { name: 'Confirmar vínculos' });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Principal/ }));
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Adicional/ }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await screen.findByRole('alert');
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      json: {
        movementId: id,
        version: 2,
        allocations: [{ transactionId: 'a' }, { transactionId: 'b' }],
      },
    });
    expect(screen.getByRole('checkbox', { name: /Adicional/ })).toBeInTheDocument();
  });
});
