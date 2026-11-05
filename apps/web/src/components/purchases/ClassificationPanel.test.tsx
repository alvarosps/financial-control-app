import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { ClassificationPanel } from './ClassificationPanel';

const id = '11111111-1111-4111-8111-111111111111';
const respond = (value: unknown) =>
  HttpResponse.json({ result: { data: superjson.serialize(value) } });
describe('reviewed classification', () => {
  it('requires a preview and confirmation, sends the displayed version and keeps failed review visible', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    server.use(
      http.get(`${TRPC_TEST_URL}/category.classificationPreview`, () =>
        respond({
          items: [
            {
              id,
              version: 'a'.repeat(64),
              description: 'Mercado',
              amount: '100.00',
              currency: 'BRL',
              categoryId: null,
              economicResponsibility: 'unknown',
              classificationSource: 'unreviewed',
              suggestion: null,
            },
          ],
          nextCursor: null,
          coverage: {
            count: 1,
            reviewedCount: 0,
            totalAmount: '100.00',
            reviewedAmount: '0.00',
            unknownResponsibilityCount: 1,
            unsupportedCurrencyCount: 0,
          },
        }),
      ),
      http.get(`${TRPC_TEST_URL}/category.list`, () =>
        respond([{ id, name: 'Alimentação', type: 'expense' }]),
      ),
      http.get(`${TRPC_TEST_URL}/account.list`, () => respond([])),
      http.get(`${TRPC_TEST_URL}/category.classificationRules`, () => respond([])),
      http.get(`${TRPC_TEST_URL}/category.classificationHistory`, () => respond([])),
      http.post(`${TRPC_TEST_URL}/category.applyClassification`, async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.error();
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <ClassificationPanel initialMonth="2026-09" />
      </TRPCTestProvider>,
    );
    expect(await screen.findByText('Mercado')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: 'Confirmar classificação' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Mercado/ }));
    await user.click(screen.getByRole('combobox', { name: 'Categoria' }));
    await user.click(await screen.findByRole('option', { name: 'Alimentação' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revisar alterações' }));
    expect(screen.getByText(/As alterações abaixo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar classificação' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(JSON.stringify(sent)).toContain('a'.repeat(64));
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível');
    expect(screen.getByRole('button', { name: 'Confirmar classificação' })).toBeInTheDocument();
  });
});
