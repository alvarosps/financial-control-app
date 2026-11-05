import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { BudgetsClient } from './BudgetsClient';

describe('BudgetsClient', () => {
  it('shows incomplete coverage, separate commitments, and preserves failed edits with their version', async () => {
    const sent: unknown[] = [];
    const respond = (data: unknown) =>
      HttpResponse.json({ result: { data: superjson.serialize(data) } });
    const progress = {
      confirmed: '80.00',
      committed: '100.00',
      provisional: '10.00',
      remaining: '310.00',
      excluded: '100.00',
      uncategorized: '10.00',
      unknownResponsibility: '190.00',
      coveragePercent: 40,
      unsupportedCurrencyCount: 0,
      reliable: false,
      exceeded: false,
      nearLimit: false,
    };
    server.use(
      http.get(`${TRPC_TEST_URL}/budget.list`, () =>
        respond({
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              categoryId: null,
              economicScope: 'own',
              limitAmount: '500.00',
              version: 7,
              progress,
            },
          ],
          summary: progress,
          receivableOutstanding: '40.00',
          asOf: new Date('2026-09-28'),
          provisional: { unallocatedCount: 1, estimatedCount: 1, truncated: false },
          coverage: [],
        }),
      ),
      http.get(`${TRPC_TEST_URL}/category.list`, () => respond([])),
      http.post(`${TRPC_TEST_URL}/budget.update`, async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.error();
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <BudgetsClient initialMonth={9} initialYear={2026} />
      </TRPCTestProvider>,
    );
    expect(await screen.findAllByText('Cobertura incompleta')).not.toHaveLength(0);
    expect(screen.getAllByText('Compromissos previstos').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Editar limite' }));
    fireEvent.change(screen.getByLabelText('Novo limite'), { target: { value: '600,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar limite' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(JSON.stringify(sent)).toContain('"version":7');
    expect(await screen.findByRole('alert')).toHaveTextContent('Recarregue');
    expect(screen.getByLabelText('Novo limite')).toHaveValue('600,00');
  });
});
