import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { renderWithProviders } from '@/test/render';
import { TRPC_TEST_URL, TRPCTestProvider } from '@/test/trpc';
import { MonthClosingChecklist } from './MonthClosingChecklist';

describe('MonthClosingChecklist', () => {
  it('requires an explicit exception and submits the reviewed fingerprint; keeps failures visible', async () => {
    const sent: unknown[] = [];
    server.use(
      http.get(`${TRPC_TEST_URL}/dashboard.closingPreview`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              reviewHash: 'a'.repeat(64),
              items: [
                {
                  key: 'classification',
                  kind: 'classification',
                  code: 'classification_low',
                  severity: 'warning',
                },
              ],
              totals: { income: '100.00', expenses: '30.00', balance: '70.00' },
            }),
          },
        }),
      ),
      http.post(`${TRPC_TEST_URL}/dashboard.closeMonth`, async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.error();
      }),
    );
    renderWithProviders(
      <TRPCTestProvider>
        <MonthClosingChecklist month={8} year={2026} onClosed={() => {}} />
      </TRPCTestProvider>,
    );
    expect(await screen.findByRole('button', { name: /Confirmar fechamento/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Justificativa/), {
      target: { value: 'Classificação pendente revisada' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar fechamento/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(JSON.stringify(sent)).toContain('a'.repeat(64));
    expect(JSON.stringify(sent)).toContain('Classificação pendente revisada');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/Justificativa/)).toHaveValue('Classificação pendente revisada');
  });
});
