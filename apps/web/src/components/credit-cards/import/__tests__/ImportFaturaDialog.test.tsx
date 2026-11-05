import { transferableAbortController } from 'node:util';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpLink } from '@trpc/client';
import { delay, HttpResponse, http } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ptMessages from '@/i18n/messages/pt-BR.json';
import { trpc } from '@/lib/trpc/client';
import { server } from '../../../../test/msw-server';
import { ImportFaturaDialog } from '../ImportFaturaDialog';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

const TRPC_URL = 'http://localhost:3000/api/trpc';

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const trpcClient = trpc.createClient({
    links: [httpLink({ url: TRPC_URL, transformer: superjson })],
  });
  return (
    <NextIntlClientProvider
      locale="pt-BR"
      messages={ptMessages as Record<string, unknown>}
      onError={() => {}}
      getMessageFallback={({ key }) => key}
    >
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('AbortController', transferableAbortController().constructor);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ImportFaturaDialog', () => {
  it('opens manual mode when unavailable and resumes an existing draft', async () => {
    const onDraftCreated = vi.fn();
    server.use(
      http.get(`${TRPC_URL}/faturaImport.capabilities`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              available: false,
              provider: 'Anthropic',
              maxBytes: 3145728,
              maxPages: 50,
              timeoutMs: 60000,
            }),
          },
        }),
      ),
      http.get(`${TRPC_URL}/faturaImport.listByCard`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize([
              {
                id: 'saved-draft',
                status: 'draft',
                fileName: 'agosto.pdf',
                billingMonth: 8,
                billingYear: 2026,
              },
            ]),
          },
        }),
      ),
      http.get(`${TRPC_URL}/faturaImport.manualPrompt`, () =>
        HttpResponse.json({ result: { data: superjson.serialize({ prompt: 'Prompt' }) } }),
      ),
    );
    render(
      <ImportFaturaDialog
        open
        onOpenChange={() => {}}
        cardId="card"
        hasProfile
        onDraftCreated={onDraftCreated}
      />,
      { wrapper: TestWrapper },
    );
    expect(await screen.findByText(/Importação automática indisponível/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Manual' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(await screen.findByRole('button', { name: /Retomar.*agosto.pdf/ }));
    expect(onDraftCreated).toHaveBeenCalledWith('saved-draft');
  });
  it('translates a temporary server failure and preserves manual input for an explicit retry', async () => {
    const onOpenChange = vi.fn();
    const onDraftCreated = vi.fn();
    let requests = 0;
    server.use(
      http.get(`${TRPC_URL}/faturaImport.manualPrompt`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({ profileId: 'generic', prompt: 'Statement prompt' }),
          },
        }),
      ),
      http.post(`${TRPC_URL}/faturaImport.uploadManual`, () => {
        requests++;
        if (requests === 1)
          return HttpResponse.json(
            {
              error: superjson.serialize({
                message: 'Unable to complete this operation.',
                code: -32603,
                data: {
                  code: 'INTERNAL_SERVER_ERROR',
                  httpStatus: 500,
                  i18nKey: 'errors.server.busy',
                },
              }),
            },
            { status: 500 },
          );
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'retry-draft' }) } });
      }),
    );
    render(
      <ImportFaturaDialog
        open
        onOpenChange={onOpenChange}
        cardId="card-retry"
        hasProfile
        onDraftCreated={onDraftCreated}
      />,
      { wrapper: TestWrapper },
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Manual' }));
    const json = '{"dueDate":"2026-09-15"}';
    fireEvent.change(screen.getByLabelText(ptMessages.statement.selectPeriod), {
      target: { value: '2026-07' },
    });
    fireEvent.change(screen.getByLabelText('Resposta JSON'), { target: { value: json } });
    const submit = screen.getByRole('button', { name: 'Importar resposta' });
    fireEvent.click(submit);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(ptMessages.errors.server.busy));
    expect(screen.getByLabelText('Resposta JSON')).toHaveValue(json);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDraftCreated).not.toHaveBeenCalled();
    expect(requests).toBe(1);
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(onDraftCreated).toHaveBeenCalledWith('retry-draft'));
    expect(requests).toBe(2);
  });

  it('keeps the selected card locked while its statement is uploading', async () => {
    const onOpenChange = vi.fn();
    const onDraftCreated = vi.fn();
    let finishUpload: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    let requests = 0;
    server.use(
      http.post(`${TRPC_URL}/faturaImport.upload`, async () => {
        requests++;
        await pending;
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'draft-locked' }) } });
      }),
    );
    render(
      <ImportFaturaDialog
        open
        onOpenChange={onOpenChange}
        cardId="card-1"
        hasProfile
        onDraftCreated={onDraftCreated}
      />,
      { wrapper: TestWrapper },
    );
    fireEvent.change(screen.getByLabelText(ptMessages.statement.selectPeriod), {
      target: { value: '2026-07' },
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: /automático/i })).toBeEnabled());
    fireEvent.click(screen.getByLabelText(ptMessages.statement.externalConsent));
    fireEvent.change(screen.getByLabelText('PDF da fatura'), {
      target: { files: [new File(['%PDF-1.4'], 'bill.pdf', { type: 'application/pdf' })] },
    });
    const submit = screen.getByRole('button', { name: /^importar$/i });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(requests).toBeGreaterThan(0));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await delay(20);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(requests).toBe(1);
    fireEvent.click(screen.getByRole('tab', { name: /manual/i }));
    expect(screen.getByRole('tab', { name: /automático/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    finishUpload?.();
    await waitFor(() => expect(onDraftCreated).toHaveBeenCalledWith('draft-locked'));
  });

  it('cancels an in-flight upload and preserves the selected document for retry', async () => {
    const onDraftCreated = vi.fn();
    let started = false;
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server.use(
      http.post(`${TRPC_URL}/faturaImport.upload`, async () => {
        started = true;
        await pending;
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'cancelled' }) } });
      }),
    );
    render(
      <ImportFaturaDialog
        open
        onOpenChange={() => {}}
        cardId="card-1"
        hasProfile
        onDraftCreated={onDraftCreated}
      />,
      { wrapper: TestWrapper },
    );
    fireEvent.change(screen.getByLabelText(ptMessages.statement.selectPeriod), {
      target: { value: '2026-07' },
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: /automático/i })).toBeEnabled());
    fireEvent.click(screen.getByLabelText(ptMessages.statement.externalConsent));
    fireEvent.change(screen.getByLabelText('PDF da fatura'), {
      target: { files: [new File(['%PDF-1.4'], 'retry.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: /^importar$/i }));
    await waitFor(() => expect(started).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /^cancelar$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^importar$/i })).toBeEnabled());
    expect((screen.getByLabelText('PDF da fatura') as HTMLInputElement).files?.[0]?.name).toBe(
      'retry.pdf',
    );
    finish?.();
    await delay(20);
    expect(onDraftCreated).not.toHaveBeenCalled();
  });

  it('encodes a valid PDF and submits it to the upload procedure', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    const onDraftCreated = vi.fn();
    server.use(
      http.post(`${TRPC_URL}/faturaImport.upload`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'draft-1' }) } });
      }),
    );

    render(
      <ImportFaturaDialog
        open={true}
        onOpenChange={() => {}}
        cardId="11111111-1111-4111-8111-111111111111"
        hasProfile={true}
        onDraftCreated={onDraftCreated}
      />,
      { wrapper: TestWrapper },
    );

    const file = new File(['%PDF-1.4 test'], 'fatura.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText(ptMessages.statement.selectPeriod), {
      target: { value: '2026-07' },
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: /automático/i })).toBeEnabled());
    fireEvent.click(screen.getByLabelText(ptMessages.statement.externalConsent));
    fireEvent.change(screen.getByLabelText('PDF da fatura'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: /^importar$/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.json).toMatchObject({
      cardAccountId: '11111111-1111-4111-8111-111111111111',
      fileName: 'fatura.pdf',
    });
    expect(String(calls[0]?.json?.pdfBase64)).toMatch(/^JVBERi0/);
    await waitFor(() => expect(onDraftCreated).toHaveBeenCalledWith('draft-1'));
  });

  it('keeps import disabled until a statement profile is selected', () => {
    render(
      <ImportFaturaDialog
        open={true}
        onOpenChange={() => {}}
        cardId="11111111-1111-4111-8111-111111111111"
        hasProfile={false}
        onDraftCreated={() => {}}
      />,
      { wrapper: TestWrapper },
    );
    expect(screen.getByRole('button', { name: /^importar$/i })).toBeDisabled();
  });

  it('copies the manual prompt and submits pasted JSON without uploading a PDF', async () => {
    const calls: Array<{ json?: Record<string, unknown> }> = [];
    const onDraftCreated = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    server.use(
      http.get(`${TRPC_URL}/faturaImport.manualPrompt`, () =>
        HttpResponse.json({
          result: {
            data: superjson.serialize({
              profileId: 'itau',
              prompt: 'PROMPT COMPLETO DA FATURA',
            }),
          },
        }),
      ),
      http.post(`${TRPC_URL}/faturaImport.uploadManual`, async ({ request }) => {
        calls.push((await request.json()) as { json?: Record<string, unknown> });
        return HttpResponse.json({ result: { data: superjson.serialize({ id: 'manual-draft' }) } });
      }),
    );

    render(
      <ImportFaturaDialog
        open={true}
        onOpenChange={() => {}}
        cardId="11111111-1111-4111-8111-111111111111"
        hasProfile={true}
        onDraftCreated={onDraftCreated}
      />,
      { wrapper: TestWrapper },
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Manual' }));
    const copyButton = await screen.findByRole('button', { name: 'Copiar prompt' });
    await waitFor(() => expect(copyButton).toBeEnabled());
    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('PROMPT COMPLETO DA FATURA'));

    fireEvent.change(screen.getByLabelText(ptMessages.statement.selectPeriod), {
      target: { value: '2026-07' },
    });
    fireEvent.change(screen.getByLabelText('Resposta JSON'), {
      target: { value: '{"dueDate":"2026-07-15"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Importar resposta' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.json).toEqual({
      cardAccountId: '11111111-1111-4111-8111-111111111111',
      provider: 'claude',
      selectedPeriod: { month: 7, year: 2026 },
      responseJson: '{"dueDate":"2026-07-15"}',
    });
    expect(onDraftCreated).toHaveBeenCalledWith('manual-draft');
  });
});
