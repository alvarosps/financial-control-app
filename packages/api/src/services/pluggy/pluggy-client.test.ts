import { describe, expect, it, vi } from 'vitest';
import { PluggyClient, type PluggyFetch } from './pluggy-client.ts';

const ITEM = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const item = {
  id: ITEM,
  status: 'UPDATED',
  connector: { id: 200, name: 'MeuPluggy' },
  lastUpdatedAt: '2026-09-28T12:00:00Z',
};
const transaction = {
  id: OTHER,
  accountId: ACCOUNT,
  description: 'Loja fixture',
  amount: -12.34,
  currencyCode: 'BRL',
  date: '2026-09-28T00:00:00Z',
  type: 'DEBIT',
  status: 'POSTED',
  createdAt: '2026-09-28T12:00:00Z',
  updatedAt: '2026-09-28T12:00:00Z',
};
function harness(handler: PluggyFetch, now = () => Date.now()) {
  let auth = 0;
  const fetcher = vi.fn<PluggyFetch>(async (url, init) => {
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (new URL(url).pathname === '/auth') {
      auth++;
      expect(JSON.parse(String(init.body))).toEqual({
        clientId: 'fixture-id',
        clientSecret: 'fixture-secret',
      });
      return Response.json({ apiKey: `key-${auth}` });
    }
    return handler(url, init);
  });
  const delay = vi.fn(async (_ms: number) => {});
  return {
    client: new PluggyClient({
      clientId: 'fixture-id',
      clientSecret: 'fixture-secret',
      fetcher,
      now,
      delay,
    }),
    fetcher,
    delay,
    auth: () => auth,
  };
}

describe('PluggyClient', () => {
  it('stops before making a request after the worker deadline', async () => {
    const fetcher = vi.fn<PluggyFetch>(async () => Response.json({ apiKey: 'fixture' }));
    const client = new PluggyClient({
      clientId: 'fixture',
      clientSecret: 'fixture',
      fetcher,
      now: () => 1000,
      deadlineAt: 1000,
    });
    await expect(client.getItem(ITEM)).rejects.toThrow('PLUGGY_DEADLINE');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('defers long rate limits without retrying before the provider deadline', async () => {
    const h = harness(async () =>
      Response.json({}, { status: 429, headers: { 'Retry-After': '120' } }),
    );
    await expect(h.client.getItem(ITEM)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 120_000,
    });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.delay).not.toHaveBeenCalled();
  });
  it('rejects malformed and oversized JSON without retaining the provider response', async () => {
    for (const response of [
      new Response('secret malformed'),
      new Response('x'.repeat(4 * 1024 * 1024 + 1)),
    ]) {
      const h = harness(async () => response);
      await expect(h.client.getItem(ITEM)).rejects.toThrow('PLUGGY_INVALID_RESPONSE');
    }
  });
  it('shares cached authentication across concurrent requests and renews before expiry', async () => {
    let now = 0;
    const h = harness(
      async () => Response.json(item),
      () => now,
    );
    await Promise.all([h.client.getItem(ITEM), h.client.getItem(ITEM)]);
    expect(h.auth()).toBe(1);
    now = 2 * 60 * 60 * 1000;
    expect(await h.client.getItem(ITEM)).toMatchObject(item);
    expect(h.auth()).toBe(2);
  });
  it('refreshes authentication once for a rejected key and bounds repeated 401', async () => {
    const h = harness(async (_url, init) =>
      new Headers(init.headers).get('X-API-KEY') === 'key-1'
        ? Response.json({ detail: 'private fixture-secret' }, { status: 401 })
        : Response.json(item),
    );
    await expect(h.client.getItem(ITEM)).resolves.toMatchObject(item);
    expect(h.auth()).toBe(2);
    const rejected = harness(async () =>
      Response.json({ detail: 'private fixture-secret' }, { status: 401 }),
    );
    await expect(rejected.client.getItem(ITEM)).rejects.toThrow('PLUGGY_UNAUTHORIZED');
    expect(rejected.auth()).toBe(2);
  });
  it('retries transient HTTP failures with bounded backoff and sanitized errors', async () => {
    let requests = 0;
    const h = harness(async () =>
      ++requests === 1
        ? Response.json({}, { status: 429, headers: { 'Retry-After': '1' } })
        : requests === 2
          ? Response.json({}, { status: 503 })
          : Response.json(item),
    );
    await expect(h.client.getItem(ITEM)).resolves.toMatchObject(item);
    expect(h.delay).toHaveBeenCalledTimes(2);
    expect(h.delay).toHaveBeenNthCalledWith(1, 1000);
    const unavailable = harness(async () =>
      Response.json({ secret: 'fixture-secret' }, { status: 503 }),
    );
    await expect(unavailable.client.getItem(ITEM)).rejects.toThrow('PLUGGY_UNAVAILABLE');
    expect(unavailable.fetcher).toHaveBeenCalledTimes(4);
  });
  it('does not leak authentication errors or fetch exceptions', async () => {
    const fetcher = vi.fn<PluggyFetch>(async () =>
      Response.json({ message: 'fixture-secret' }, { status: 401 }),
    );
    const client = new PluggyClient({
      clientId: 'fixture-id',
      clientSecret: 'fixture-secret',
      fetcher,
    });
    await expect(client.getItem(ITEM)).rejects.toThrow('PLUGGY_UNAUTHORIZED');
    expect(fetcher).toHaveBeenCalledOnce();
    const h = harness(async () => {
      throw new DOMException('private financial payload', 'TimeoutError');
    });
    await expect(h.client.getItem(ITEM)).rejects.toThrow('PLUGGY_TIMEOUT');
  });
  it('continues after an empty cursor page and preserves exact filters and opaque cursor', async () => {
    const next = `?accountId=${ACCOUNT}&dateFrom=2026-09-01&after=opaque%2Bcursor%3D`;
    const h = harness(async (url) =>
      url.endsWith(next)
        ? Response.json({ results: [transaction], next: null })
        : Response.json({ results: [], next }),
    );
    const pages = [];
    for await (const page of h.client.transactionPages(ACCOUNT, { dateFrom: '2026-09-01' }))
      pages.push(page);
    expect(pages).toHaveLength(2);
    expect(pages[1]).toMatchObject({ results: [transaction], next: null });
    expect(h.auth()).toBe(1);
  });
  it.each([
    'https://evil.test/v2/transactions?accountId=ACCOUNT&after=x',
    'http://api.pluggy.ai/v2/transactions?accountId=ACCOUNT&after=x',
    'https://user:secret@api.pluggy.ai/v2/transactions?accountId=ACCOUNT&after=x',
    '/items?accountId=ACCOUNT&after=x',
    `?accountId=${OTHER}&after=x`,
    '?accountId=ACCOUNT&accountId=ACCOUNT&after=x',
    '?accountId=ACCOUNT&after=x&unknown=y',
    '?accountId=ACCOUNT&after=x#fragment',
  ])('rejects unsafe or scope-changing continuation %s before fetching it', async (candidate) => {
    const h = harness(async () =>
      Response.json({ results: [], next: candidate.replaceAll('ACCOUNT', ACCOUNT) }),
    );
    await expect(h.client.getTransactionsPage(ACCOUNT)).rejects.toThrow('PLUGGY_CURSOR_INVALID');
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects missing filters and cursor loops instead of truncating silently', async () => {
    const next = `?accountId=${ACCOUNT}&after=repeat`;
    const h = harness(async () => Response.json({ results: [], next }));
    await expect(h.client.getTransactionsPage(ACCOUNT, { dateFrom: '2026-09-01' })).rejects.toThrow(
      'PLUGGY_CURSOR_INVALID',
    );
    const read = async () => {
      for await (const _page of h.client.transactionPages(ACCOUNT)) {
        /* consume */
      }
    };
    await expect(read()).rejects.toThrow('PLUGGY_CURSOR_REPEATED');
  });
  it('validates response schemas and account ownership without exposing payloads', async () => {
    const wrongAccount = harness(async () =>
      Response.json({ results: [{ ...transaction, accountId: OTHER }], next: null }),
    );
    await expect(wrongAccount.client.getTransactionsPage(ACCOUNT)).rejects.toThrow(
      'PLUGGY_SCOPE_MISMATCH',
    );
    const invalid = harness(async () =>
      Response.json({ results: [{ private: 'fixture-secret' }], next: null }),
    );
    await expect(invalid.client.getTransactionsPage(ACCOUNT)).rejects.toThrow(
      'PLUGGY_INVALID_RESPONSE',
    );
    const wrongItem = harness(async () => Response.json({ ...item, id: OTHER }));
    await expect(wrongItem.client.getItem(ITEM)).rejects.toThrow('PLUGGY_SCOPE_MISMATCH');
  });
  it('reads all account and bill pages and rejects inconsistent page metadata', async () => {
    const account = {
      id: ACCOUNT,
      itemId: ITEM,
      type: 'CREDIT',
      name: 'Cartao fixture',
      currencyCode: 'BRL',
      balance: 12.34,
    };
    const bill = {
      id: OTHER,
      dueDate: '2026-10-15T00:00:00',
      billClosingDate: '2026-10-08T00:00:00',
      totalAmount: 12.34,
      totalAmountCurrencyCode: 'BRL',
    };
    const h = harness(async (input) => {
      const url = new URL(input);
      const page = Number(url.searchParams.get('page'));
      return Response.json({
        page,
        total: 1,
        totalPages: 2,
        results: page === 1 ? [] : [url.pathname === '/accounts' ? account : bill],
      });
    });
    expect(await h.client.getAccounts(ITEM)).toEqual([account]);
    expect(await h.client.getBills(ACCOUNT)).toEqual([bill]);
    const invalid = harness(async () =>
      Response.json({ page: 2, totalPages: 2, total: 0, results: [] }),
    );
    await expect(invalid.client.getAccounts(ITEM)).rejects.toThrow('PLUGGY_INVALID_RESPONSE');
  });
});
