import { z } from 'zod';
import {
  type PluggyTransactionFilters,
  type PluggyTransactionPage,
  pluggyAccountSchema,
  pluggyBillSchema,
  pluggyId,
  pluggyItemSchema,
  pluggyTransactionFiltersSchema,
  pluggyTransactionPageSchema,
} from './pluggy-types.ts';

const ORIGIN = 'https://api.pluggy.ai';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export type PluggyFetch = (url: string, init: RequestInit) => Promise<Response>;
type Options = {
  clientId: string;
  clientSecret: string;
  fetcher?: PluggyFetch;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  deadlineAt?: number;
};
export class PluggyError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs = 0,
  ) {
    super(`PLUGGY_${code}`);
    this.name = 'PluggyError';
  }
}
function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new PluggyError('INVALID_RESPONSE');
  return result.data;
}
function requireId(id: string) {
  if (!pluggyId.safeParse(id).success) throw new PluggyError('INVALID_REQUEST');
  return id;
}
function transactionUrl(accountId: string, filters: PluggyTransactionFilters) {
  requireId(accountId);
  const result = pluggyTransactionFiltersSchema.safeParse(filters);
  if (!result.success) throw new PluggyError('INVALID_REQUEST');
  const url = new URL('/v2/transactions', ORIGIN);
  url.searchParams.set('accountId', accountId);
  for (const [key, value] of Object.entries(result.data)) {
    if (value !== undefined)
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : value);
  }
  return url;
}
export function validatePluggyCursor(
  accountId: string,
  filters: PluggyTransactionFilters,
  cursor: string,
) {
  const expected = transactionUrl(accountId, filters);
  let next: URL;
  try {
    next = new URL(cursor, expected);
  } catch {
    throw new PluggyError('CURSOR_INVALID');
  }
  if (
    cursor.length > 16_384 ||
    next.origin !== ORIGIN ||
    next.pathname !== expected.pathname ||
    next.username ||
    next.password ||
    next.hash ||
    !next.searchParams.get('after')
  ) {
    throw new PluggyError('CURSOR_INVALID');
  }
  for (const [key, value] of expected.searchParams) {
    if (next.searchParams.get(key) !== value) throw new PluggyError('CURSOR_INVALID');
  }
  for (const key of next.searchParams.keys()) {
    if (
      next.searchParams.getAll(key).length !== 1 ||
      (key !== 'after' && !expected.searchParams.has(key))
    ) {
      throw new PluggyError('CURSOR_INVALID');
    }
  }
  return next.toString();
}
async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new PluggyError('INVALID_RESPONSE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PluggyError('INVALID_RESPONSE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PluggyError('INVALID_RESPONSE');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new PluggyError('INVALID_RESPONSE');
  } finally {
    reader.releaseLock();
  }
}
export class PluggyClient {
  private readonly fetcher: PluggyFetch;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private key: { value: string; expires: number } | undefined;
  private authenticating: Promise<string> | undefined;
  constructor(private readonly options: Options) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  private async request(url: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = (this.options.deadlineAt ?? Number.POSITIVE_INFINITY) - this.now();
      if (remaining < 1000) throw new PluggyError('DEADLINE');
      let response: Response;
      try {
        response = await this.fetcher(url, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(15_000, remaining)),
        });
      } catch (error) {
        const code =
          error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
            ? 'TIMEOUT'
            : 'NETWORK';
        if (attempt === 2) throw new PluggyError(code);
        await this.delay(100 * 2 ** attempt);
        continue;
      }
      if (response.ok) return boundedJson(response);
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new PluggyError('UNAUTHORIZED');
      if (response.status === 404) throw new PluggyError('NOT_FOUND');
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get('retry-after');
        const milliseconds =
          retry === null
            ? 100 * 2 ** attempt
            : /^\d+(\.\d+)?$/.test(retry)
              ? Number(retry) * 1000
              : Date.parse(retry) - this.now();
        const backoff = Number.isFinite(milliseconds)
          ? Math.max(100, Math.min(900_000, milliseconds))
          : 100 * 2 ** attempt;
        if (attempt === 2 || backoff > 2000)
          throw new PluggyError(response.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE', backoff);
        await this.delay(backoff);
        continue;
      }
      throw new PluggyError('REQUEST_REJECTED');
    }
    throw new PluggyError('UNAVAILABLE');
  }
  private async authenticate(): Promise<string> {
    if (this.key && this.key.expires > this.now()) return this.key.value;
    if (this.authenticating) return this.authenticating;
    const started = this.now();
    this.authenticating = (async () => {
      const data = parse(
        z.object({ apiKey: z.string().min(1).max(4096) }),
        await this.request(`${ORIGIN}/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: this.options.clientId,
            clientSecret: this.options.clientSecret,
          }),
        }),
      );
      this.key = { value: data.apiKey, expires: started + 115 * 60_000 };
      return data.apiKey;
    })();
    try {
      return await this.authenticating;
    } finally {
      this.authenticating = undefined;
    }
  }
  private async get(url: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = await this.authenticate();
      try {
        return await this.request(url, { headers: { 'X-API-KEY': key } });
      } catch (error) {
        if (!(error instanceof PluggyError) || error.code !== 'UNAUTHORIZED' || attempt === 1)
          throw error;
        if (this.key?.value === key) this.key = undefined;
      }
    }
    throw new PluggyError('UNAUTHORIZED');
  }
  async getItem(id: string) {
    const item = parse(pluggyItemSchema, await this.get(`${ORIGIN}/items/${requireId(id)}`));
    if (item.id !== id) throw new PluggyError('SCOPE_MISMATCH');
    return item;
  }
  private async numberedPages<T extends { id: string }>(
    path: string,
    key: string,
    id: string,
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    requireId(id);
    const results: T[] = [];
    const ids = new Set<string>();
    let total: number | undefined;
    let totalPages: number | undefined;
    for (let page = 1; page <= 1000; page++) {
      const url = new URL(path, ORIGIN);
      url.searchParams.set(key, id);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', '500');
      const data = parse(
        z.object({
          page: z.number().int().positive(),
          total: z.number().int().nonnegative(),
          totalPages: z.number().int().min(0).max(1000),
          results: z.array(schema).max(500),
        }),
        await this.get(url.toString()),
      );
      if (
        data.page !== page ||
        (total !== undefined && total !== data.total) ||
        (totalPages !== undefined && totalPages !== data.totalPages)
      )
        throw new PluggyError('INVALID_RESPONSE');
      total = data.total;
      totalPages = data.totalPages;
      for (const row of data.results) {
        if (ids.has(row.id)) throw new PluggyError('INVALID_RESPONSE');
        ids.add(row.id);
        results.push(row);
      }
      if (page >= totalPages) {
        if (results.length !== total) throw new PluggyError('INVALID_RESPONSE');
        return results;
      }
    }
    throw new PluggyError('PAGE_LIMIT');
  }
  async getAccounts(itemId: string) {
    const accounts = await this.numberedPages('/accounts', 'itemId', itemId, pluggyAccountSchema);
    if (accounts.some((account) => account.itemId !== itemId))
      throw new PluggyError('SCOPE_MISMATCH');
    return accounts;
  }
  async getBills(accountId: string) {
    return this.numberedPages('/bills', 'accountId', accountId, pluggyBillSchema);
  }
  async getTransactionsPage(
    accountId: string,
    filters: PluggyTransactionFilters = {},
    cursor: string | null = null,
  ): Promise<PluggyTransactionPage> {
    const url =
      cursor === null
        ? transactionUrl(accountId, filters).toString()
        : validatePluggyCursor(accountId, filters, cursor);
    const page = parse(pluggyTransactionPageSchema, await this.get(url));
    if (page.results.some((row) => row.accountId !== accountId))
      throw new PluggyError('SCOPE_MISMATCH');
    if (page.next !== null) validatePluggyCursor(accountId, filters, page.next);
    return page;
  }
  async *transactionPages(
    accountId: string,
    filters: PluggyTransactionFilters = {},
  ): AsyncGenerator<PluggyTransactionPage> {
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let count = 0; count < 10_000; count++) {
      const page = await this.getTransactionsPage(accountId, filters, cursor);
      if (page.next !== null) {
        const next = new URL(validatePluggyCursor(accountId, filters, page.next));
        next.searchParams.sort();
        if (seen.has(next.toString())) throw new PluggyError('CURSOR_REPEATED');
        seen.add(next.toString());
      }
      yield page;
      if (page.next === null) return;
      cursor = page.next;
    }
    throw new PluggyError('PAGE_LIMIT');
  }
}
