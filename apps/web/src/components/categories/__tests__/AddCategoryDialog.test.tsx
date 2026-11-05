import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc/client';
import { renderDialog } from '@/test/dialog';
import { server } from '../../../test/msw-server';
import { AddCategoryDialog } from '../AddCategoryDialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));
afterEach(() => vi.clearAllMocks());

function CategoryListProbe() {
  trpc.category.list.useQuery();
  return null;
}

describe('AddCategoryDialog', () => {
  it('submits the category payload through the tRPC HTTP boundary', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    server.use(
      http.post('http://localhost:3000/api/trpc/category.create', async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
    );
    renderDialog(<AddCategoryDialog open onOpenChange={() => {}} />);
    const name = screen.getByLabelText(/nome da categoria/i);
    fireEvent.change(name, { target: { value: 'Mercado' } });
    const form = name.closest('form');
    if (!form) throw new Error('expected category form');
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].json).toMatchObject({ name: 'Mercado', type: 'expense' });
  });

  it('guards pending close, invalidates categories, and resets after success', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    server.use(
      http.post('http://localhost:3000/api/trpc/category.create', async () => {
        await pending;
        return HttpResponse.json({ result: { data: superjson.serialize({}) } });
      }),
      http.post('http://localhost:3000/api/trpc/category.list', () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
      http.get('http://localhost:3000/api/trpc/category.list', () => {
        listCalls += 1;
        return HttpResponse.json({ result: { data: superjson.serialize([]) } });
      }),
    );
    const onOpenChange = vi.fn();
    renderDialog(
      <>
        <AddCategoryDialog open onOpenChange={onOpenChange} />
        <CategoryListProbe />
      </>,
    );
    const name = screen.getByLabelText(/nome da categoria/i);
    fireEvent.change(name, { target: { value: 'Mercado' } });
    fireEvent.submit(name.closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('button', { name: /salvando/i })).toBeDisabled());
    expect(screen.getByRole('button', { name: /cancelar/i })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    release?.();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    expect(name).toHaveValue('');
  });

  it('shows the mutation error', async () => {
    server.use(
      http.post('http://localhost:3000/api/trpc/category.create', () =>
        HttpResponse.json(
          {
            error: {
              json: { message: 'Categoria indisponível', code: -32603, data: { httpStatus: 500 } },
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderDialog(<AddCategoryDialog open onOpenChange={() => {}} />);
    const name = screen.getByLabelText(/nome da categoria/i);
    fireEvent.change(name, { target: { value: 'Mercado' } });
    fireEvent.submit(name.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Categoria indisponível'),
    );
  });
});
