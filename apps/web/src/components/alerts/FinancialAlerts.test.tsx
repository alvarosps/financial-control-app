import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { FinancialAlerts } from './FinancialAlerts';

describe('FinancialAlerts', () => {
  it('explains recurring evidence and sends a versioned mute decision without hiding a failure', async () => {
    const sent: unknown[] = [];
    const respond = (data: unknown) =>
      HttpResponse.json({ result: { data: superjson.serialize(data) } });
    const result = {
      month: 9,
      year: 2026,
      truncated: false,
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          rule: 'recurring_price',
          state: 'open',
          active: true,
          revision: 4,
          evidence: {
            label: 'Service 123',
            amount: '60.00',
            previousAmount: '50.00',
            count: 3,
            sampleDates: ['2026-07-05', '2026-08-05', '2026-09-05'],
            toleranceAmount: '2.50',
            basis: 'monthly_25_35_days',
          },
        },
      ],
    };
    server.use(
      http.get(`${TRPC_TEST_URL}/financialAlert.list`, () => respond(result)),
      http.post(`${TRPC_TEST_URL}/financialAlert.refresh`, () => respond(result)),
      http.post(`${TRPC_TEST_URL}/financialAlert.setState`, async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.error();
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <FinancialAlerts month={9} year={2026} />
      </TRPCTestProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Alertas financeiros' }));
    expect(await screen.findByText('Service 123')).toBeInTheDocument();
    expect(screen.getByText(/25 a 35 dias/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Silenciar' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(JSON.stringify(sent)).toContain('"revision":4');
    expect(await screen.findByRole('alert')).toHaveTextContent('Recarregue');
    expect(screen.getByText('Service 123')).toBeInTheDocument();
  });
});
