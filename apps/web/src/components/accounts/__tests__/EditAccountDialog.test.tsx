import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc/client';
import { renderDialog } from '@/test/dialog';
import { server } from '../../../test/msw-server';
import { EditAccountDialog } from '../EditAccountDialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));
afterEach(() => vi.clearAllMocks());

function AccountListProbe() {
  trpc.account.list.useQuery();
  return null;
}

describe('EditAccountDialog', () => {
  it('preserves the account id and edited name in the HTTP mutation payload', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post('http://localhost:3000/api/trpc/account.update', async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    renderDialog(
      <EditAccountDialog
        open
        account={{ id: 'account-id', name: 'Antiga', type: 'checking' }}
        onOpenChange={() => {}}
      />,
    );
    const name = screen.getByLabelText(/nome da conta/i);
    fireEvent.change(name, { target: { value: 'Nova' } });
    const form = name.closest('form');
    if (!form) throw new Error('expected account form');
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].json).toMatchObject({ id: 'account-id', name: 'Nova' });
  });

  it('keeps the dialog open and disabled while pending, then invalidates on success', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    server.use(
      http.post('http://localhost:3000/api/trpc/account.update', async () => {
        await pending;
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
      http.post('http://localhost:3000/api/trpc/account.list', () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
      http.get('http://localhost:3000/api/trpc/account.list', () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
    );
    const onOpenChange = vi.fn();
    renderDialog(
      <>
        <EditAccountDialog
          open
          account={{ id: 'account-id', name: 'Antiga', type: 'checking' }}
          onOpenChange={onOpenChange}
        />
        <AccountListProbe />
      </>,
    );
    const name = screen.getByLabelText(/nome da conta/i);
    fireEvent.submit(name.closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('button', { name: /salvando/i })).toBeDisabled());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    release?.();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('surfaces an update error', async () => {
    server.use(
      http.post('http://localhost:3000/api/trpc/account.update', () =>
        HttpResponse.json(
          {
            error: {
              json: { message: 'Não foi possível salvar', code: -32603, data: { httpStatus: 500 } },
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderDialog(
      <EditAccountDialog
        open
        account={{ id: 'account-id', name: 'Antiga', type: 'checking' }}
        onOpenChange={() => {}}
      />,
    );
    fireEvent.submit(screen.getByLabelText(/nome da conta/i).closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Não foi possível salvar'),
    );
  });
});
