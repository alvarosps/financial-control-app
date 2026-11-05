import { describe, expect, it, vi } from 'vitest';
import { ClaudeFaturaParser } from './claude-pdf-parser.ts';
import { getFaturaProfile } from './profiles.ts';

const PDF_BASE64 = Buffer.from('%PDF-1.4 fake').toString('base64');
const VALID_FATURA = {
  dueDate: '2026-07-15',
  statedTotal: '314.32',
  cards: [
    {
      lastFour: '9859',
      holderName: 'ALVARO SOUZA',
      isAdditional: false,
      items: [
        {
          description: 'UBER TRIP',
          amountBRL: '25.90',
          purchaseDate: '2026-06-02',
          installmentCurrent: null,
          installmentTotal: null,
          isRefund: false,
        },
      ],
    },
    {
      lastFour: '8516',
      holderName: 'CAMILA STEINMETZ',
      isAdditional: true,
      items: [
        {
          description: 'SEPHORA',
          amountBRL: '288.42',
          purchaseDate: null,
          installmentCurrent: 2,
          installmentTotal: 12,
          isRefund: false,
        },
      ],
    },
  ],
};

function anthropicResponse(input: unknown): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'extract_fatura', input }],
      stop_reason: 'tool_use',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('ClaudeFaturaParser', () => {
  it('aborts the outgoing request on cancellation and timeout without retrying', async () => {
    vi.useFakeTimers();
    const timeoutClock = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const clockController = new AbortController();
      setTimeout(() => clockController.abort(new DOMException('Timed out', 'TimeoutError')), ms);
      return clockController.signal;
    });
    try {
      const fetchFn = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const parser = new ClaudeFaturaParser({ apiKey: 'test-key', fetchFn });
      const controller = new AbortController();
      const cancelled = parser.parse({
        pdfBase64: PDF_BASE64,
        profile: getFaturaProfile('generic'),
        signal: controller.signal,
      });
      const cancellation = expect(cancelled).rejects.toThrow();
      controller.abort();
      await cancellation;
      const timeout = expect(
        parser.parse({ pdfBase64: PDF_BASE64, profile: getFaturaProfile('generic') }),
      ).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      await timeout;
      expect(timeoutClock).toHaveBeenLastCalledWith(60_000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
  it('sends a PDF document with forced strict tool use and disabled thinking', async () => {
    const fetchFn = vi.fn().mockResolvedValue(anthropicResponse(VALID_FATURA));
    const parser = new ClaudeFaturaParser({ apiKey: 'test-key', fetchFn });

    const result = await parser.parse({
      pdfBase64: PDF_BASE64,
      profile: getFaturaProfile('itau'),
    });

    expect(result.cards[1]?.isAdditional).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
    const body = JSON.parse(String(init.body)) as {
      model: string;
      system: string;
      temperature?: number;
      thinking: { type: string };
      tool_choice: { type: string; name: string };
      tools: { strict: boolean }[];
      messages: { content: { type: string; source?: { media_type: string } }[] }[];
    };
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.system).toContain('aloque os pagamentos ao saldo anterior primeiro');
    expect(body.system).toContain('isRefund=true');
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'extract_fatura' });
    expect(body.tools[0]?.strict).toBe(true);
    expect(body.messages[0]?.content[0]).toMatchObject({
      type: 'document',
      source: { media_type: 'application/pdf' },
    });
  });

  it('uses an explicit model override', async () => {
    const fetchFn = vi.fn().mockResolvedValue(anthropicResponse(VALID_FATURA));
    const parser = new ClaudeFaturaParser({ apiKey: 'key', model: 'claude-sonnet-4-6', fetchFn });
    await parser.parse({ pdfBase64: PDF_BASE64, profile: getFaturaProfile('generic') });
    const body = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body)) as {
      model: string;
    };
    expect(body.model).toBe('claude-sonnet-4-6');
  });

  it('sanitizes incomplete or impossible installment pairs', async () => {
    const bad = structuredClone(VALID_FATURA);
    const item = bad.cards[0]?.items[0];
    if (item) {
      item.installmentCurrent = 12;
      item.installmentTotal = 2;
    }
    const parser = new ClaudeFaturaParser({
      apiKey: 'key',
      fetchFn: vi.fn().mockResolvedValue(anthropicResponse(bad)),
    });
    const result = await parser.parse({
      pdfBase64: PDF_BASE64,
      profile: getFaturaProfile('generic'),
    });
    expect(result.cards[0]?.items[0]).toMatchObject({
      installmentCurrent: null,
      installmentTotal: null,
    });
  });

  it('reports HTTP failures without exposing credentials', async () => {
    const parser = new ClaudeFaturaParser({
      apiKey: 'secret-key',
      fetchFn: vi.fn().mockResolvedValue(new Response('overloaded', { status: 529 })),
    });
    const promise = parser.parse({ pdfBase64: PDF_BASE64, profile: getFaturaProfile('generic') });
    await expect(promise).rejects.toThrow(/529/);
    await expect(promise).rejects.not.toThrow(/secret-key/);
  });

  it('rejects responses without the forced tool block', async () => {
    const parser = new ClaudeFaturaParser({
      apiKey: 'key',
      fetchFn: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tool' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    });
    await expect(
      parser.parse({ pdfBase64: PDF_BASE64, profile: getFaturaProfile('generic') }),
    ).rejects.toThrow(/tool_use/);
  });

  it('rejects invalid money shapes returned by the model', async () => {
    const bad = structuredClone(VALID_FATURA);
    const item = bad.cards[0]?.items[0];
    if (item) item.amountBRL = '25,90';
    const parser = new ClaudeFaturaParser({
      apiKey: 'key',
      fetchFn: vi.fn().mockResolvedValue(anthropicResponse(bad)),
    });
    await expect(
      parser.parse({ pdfBase64: PDF_BASE64, profile: getFaturaProfile('generic') }),
    ).rejects.toThrow();
  });
});
