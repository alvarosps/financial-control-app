import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc/client';
import { renderDialog } from '@/test/dialog';
import { server } from '../../../test/msw-server';
import { DeactivateChargeDialog } from '../DeactivateChargeDialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));
afterEach(() => vi.clearAllMocks());

function ChargeListProbe() {
  trpc.charges.list.useQuery();
  return null;
}

describe('DeactivateChargeDialog', () => {
  it('confirms exactly one deactivation through the tRPC HTTP boundary', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post('http://localhost:3000/api/trpc/charges.deactivate', async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    renderDialog(
      <DeactivateChargeDialog open scheduleId="charge-id" name="Aluguel" onOpenChange={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remover/i }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].json).toMatchObject({ scheduleId: 'charge-id' });
  });

  it('prevents repeat confirmation and close while pending, then invalidates charges', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    server.use(
      http.post('http://localhost:3000/api/trpc/charges.deactivate', async () => {
        await pending;
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
      http.post('http://localhost:3000/api/trpc/charges.list', () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
      http.get('http://localhost:3000/api/trpc/charges.list', () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
    );
    const onOpenChange = vi.fn();
    renderDialog(
      <>
        <DeactivateChargeDialog
          open
          scheduleId="charge-id"
          name="Aluguel"
          onOpenChange={onOpenChange}
        />
        <ChargeListProbe />
      </>,
    );
    const confirm = screen.getByRole('button', { name: /remover/i });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    release?.();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('shows a translated error when deactivation fails', async () => {
    server.use(
      http.post('http://localhost:3000/api/trpc/charges.deactivate', () =>
        HttpResponse.json(
          {
            error: {
              json: { message: 'Cobrança indisponível', code: -32603, data: { httpStatus: 500 } },
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderDialog(
      <DeactivateChargeDialog open scheduleId="charge-id" name="Aluguel" onOpenChange={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remover/i }));
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Cobrança indisponível'),
    );
  });
});
