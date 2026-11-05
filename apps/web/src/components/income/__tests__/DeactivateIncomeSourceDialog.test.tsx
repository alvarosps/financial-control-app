import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc/client';
import { renderDialog } from '@/test/dialog';
import { server } from '../../../test/msw-server';
import { DeactivateIncomeSourceDialog } from '../DeactivateIncomeSourceDialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));
afterEach(() => vi.clearAllMocks());

function IncomeListProbe() {
  trpc.income.list.useQuery();
  return null;
}

describe('DeactivateIncomeSourceDialog', () => {
  it('confirms exactly one deactivation through the tRPC HTTP boundary', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post('http://localhost:3000/api/trpc/income.deactivate', async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    renderDialog(
      <DeactivateIncomeSourceDialog
        open
        accountId="income-id"
        name="Salário"
        onOpenChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /desativar/i }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].json).toMatchObject({ accountId: 'income-id' });
  });

  it('blocks repeated confirmation and closing while pending, then invalidates income', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    server.use(
      http.post('http://localhost:3000/api/trpc/income.deactivate', async () => {
        await pending;
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
      http.post('http://localhost:3000/api/trpc/income.list', () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
      http.get('http://localhost:3000/api/trpc/income.list', () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
    );
    const onOpenChange = vi.fn();
    renderDialog(
      <>
        <DeactivateIncomeSourceDialog
          open
          accountId="income-id"
          name="Salário"
          onOpenChange={onOpenChange}
        />
        <IncomeListProbe />
      </>,
    );
    const confirm = screen.getByRole('button', { name: /desativar/i });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    release?.();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('shows an error when deactivation fails', async () => {
    server.use(
      http.post('http://localhost:3000/api/trpc/income.deactivate', () =>
        HttpResponse.json(
          {
            error: {
              json: { message: 'Renda indisponível', code: -32603, data: { httpStatus: 500 } },
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderDialog(
      <DeactivateIncomeSourceDialog
        open
        accountId="income-id"
        name="Salário"
        onOpenChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /desativar/i }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Renda indisponível'));
  });
});
