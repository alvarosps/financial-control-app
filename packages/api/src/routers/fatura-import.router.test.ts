import type { DbExecutor } from '@fc/db';
import { accounts, creditCardConfigs, userProfiles } from '@fc/db';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { sql } from 'drizzle-orm';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { appRouter } from '../root.ts';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory } from '../trpc.ts';

const createCaller = createCallerFactory(appRouter);

async function callerFor(db: DbExecutor) {
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `fatura-router-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Fatura Router Test',
      passwordHash: 'hash',
    })
    .returning();
  return createCaller({ db, userId: user.id, profileCache: createRequestProfileCache(db) });
}

describe('faturaImportRouter', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('exposes authenticated parser capabilities without configuration secrets', async () => {
    await withRollback(async (db) => {
      const caller = await callerFor(db);
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      expect(await caller.faturaImport.capabilities()).toEqual({
        available: false,
        provider: 'Anthropic',
        maxBytes: 3 * 1024 * 1024,
        maxPages: 50,
        timeoutMs: 60000,
      });
      vi.stubEnv('ANTHROPIC_API_KEY', 'private-test-key');
      const result = await caller.faturaImport.capabilities();
      expect(result.available).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private-test-key');
      const anonymous = createCaller({
        db,
        userId: null,
        profileCache: createRequestProfileCache(db),
      });
      await expect(anonymous.faturaImport.capabilities()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
  it('imports a manual statement over POST as app_user and rejects GET without creating a draft', async () => {
    await withRollback(async (db) => {
      const user = await createTestUser(db);
      const [card] = await db
        .insert(accounts)
        .values({ userId: user.id, name: 'Import card', type: 'credit_card' })
        .returning();
      await db
        .insert(creditCardConfigs)
        .values({ accountId: card.id, closingDay: 5, dueDay: 15, billParserType: 'generic' });
      await db.execute(sql`SET LOCAL ROLE app_user`);
      const now = new Date();
      const dueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-15`;
      const input = {
        cardAccountId: card.id,
        provider: 'claude',
        responseJson: JSON.stringify({
          dueDate,
          statedTotal: '19.90',
          cards: [
            {
              lastFour: null,
              holderName: null,
              isAdditional: false,
              items: [
                {
                  description: 'Fee',
                  amountBRL: '19.90',
                  purchaseDate: null,
                  installmentCurrent: null,
                  installmentTotal: null,
                  isRefund: false,
                },
              ],
            },
          ],
        }),
      };
      const request = (method: 'GET' | 'POST') =>
        fetchRequestHandler({
          endpoint: '/api/trpc',
          req: new Request('http://localhost/api/trpc/faturaImport.uploadManual?batch=1', {
            method,
            headers: { 'content-type': 'application/json' },
            ...(method === 'POST'
              ? { body: JSON.stringify({ '0': superjson.serialize(input) }) }
              : {}),
          }),
          router: appRouter,
          createContext: async () => ({
            db,
            userId: user.id,
            profileCache: createRequestProfileCache(db),
          }),
        });
      const rejected = await request('GET');
      expect(rejected.status).toBe(405);
      const response = await request('POST');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject([
        {
          result: {
            data: {
              json: {
                cardAccountId: card.id,
                status: 'draft',
                modelUsed: 'manual-claude',
              },
            },
          },
        },
      ]);
      const caller = createCaller({
        db,
        userId: user.id,
        profileCache: createRequestProfileCache(db),
      });
      const drafts = await caller.faturaImport.listByCard({ cardAccountId: card.id });
      expect(drafts).toHaveLength(1);
      const bill = await caller.creditCard.getConsolidatedBill({
        cardAccountId: card.id,
        month: now.getMonth() + 1,
        year: now.getFullYear(),
      });
      expect(bill.total).toBe(0);
    });
  });

  it('lists parser profiles to authenticated callers', async () => {
    await withRollback(async (db) => {
      const caller = await callerFor(db);
      await expect(caller.faturaImport.profiles()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'generic' })]),
      );
    });
  });

  it('rejects oversized upload payloads before invoking the parser', async () => {
    await withRollback(async (db) => {
      const caller = await callerFor(db);
      await expect(
        caller.faturaImport.upload({
          cardAccountId: crypto.randomUUID(),
          fileName: 'large.pdf',
          externalConsent: true,
          pdfBase64: 'A'.repeat(4 * 1024 * 1024 + 8),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('rejects invalid providers and oversized manual responses at the router boundary', async () => {
    await withRollback(async (db) => {
      const caller = await callerFor(db);
      await expect(
        caller.faturaImport.uploadManual({
          cardAccountId: crypto.randomUUID(),
          provider: JSON.parse('"invalid"'),
          responseJson: '{}',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.faturaImport.uploadManual({
          cardAccountId: crypto.randomUUID(),
          provider: 'claude',
          responseJson: 'A'.repeat(1024 * 1024 + 1),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
});
