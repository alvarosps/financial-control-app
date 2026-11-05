import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc/client';
import { renderDialog } from '@/test/dialog';
import { server } from '../../../test/msw-server';
import { AddAccountDialog } from '../AddAccountDialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));

afterEach(() => vi.clearAllMocks());

function AccountListProbe() {
  trpc.account.list.useQuery();
  return null;
}

function ControlledAccountDialog({ onChange }: { onChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  function onOpenChange(next: boolean) {
    onChange(next);
    setOpen(next);
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen account dialog
      </button>
      <AddAccountDialog open={open} onOpenChange={onOpenChange} />
      <AccountListProbe />
    </>
  );
}

describe('AddAccountDialog', () => {
  it('submits its current form values through the tRPC HTTP boundary', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post('http://localhost:3000/api/trpc/account.create', async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    renderDialog(<AddAccountDialog open onOpenChange={() => {}} />);
    const name = screen.getByLabelText(/nome da conta/i);
    fireEvent.change(name, { target: { value: 'Reserva' } });
    const form = name.closest('form');
    if (!form) throw new Error('expected account form');
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].json).toMatchObject({ name: 'Reserva', type: 'checking', currency: 'BRL' });
  });

  it('blocks close while pending, invalidates account data after success, and resets on reopen', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    server.use(
      http.post('http://localhost:3000/api/trpc/account.create', async () => {
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
    renderDialog(<ControlledAccountDialog onChange={onOpenChange} />);
    await waitFor(() => expect(listCalls).toBe(1));
    const name = screen.getByLabelText(/nome da conta/i);
    fireEvent.change(name, { target: { value: 'Reserva' } });
    fireEvent.submit(name.closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('button', { name: /salvando/i })).toBeDisabled());
    expect(screen.getByRole('button', { name: /cancelar/i })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    release?.();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(listCalls).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: /reopen account dialog/i }));
    const reopenedName = await screen.findByLabelText(/nome da conta/i);
    expect(reopenedName).toHaveValue('');
  });

  it('shows the server error without closing', async () => {
    server.use(
      http.post('http://localhost:3000/api/trpc/account.create', () =>
        HttpResponse.json(
          {
            error: {
              json: { message: 'Conta indisponível', code: -32603, data: { httpStatus: 500 } },
            },
          },
          { status: 500 },
        ),
      ),
    );
    const onOpenChange = vi.fn();
    renderDialog(<AddAccountDialog open onOpenChange={onOpenChange} />);
    const name = screen.getByLabelText(/nome da conta/i);
    fireEvent.change(name, { target: { value: 'Reserva' } });
    fireEvent.submit(name.closest('form') as HTMLFormElement);
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Conta indisponível'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
