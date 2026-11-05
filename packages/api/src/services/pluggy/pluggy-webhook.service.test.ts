import { randomUUID } from 'node:crypto';
import { externalConnections, integrationJobs } from '@fc/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { purchaseFixture } from '../../test/purchase-fixture.ts';
import { withRollback } from '../../test/with-rollback.ts';
import { handlePluggyWebhook } from './pluggy-webhook.service.ts';

describe('Pluggy webhook', () => {
  it('authenticates before parsing and durably queues one owned event without fetching its URL', async () => {
    await withRollback(async (db) => {
      const a = await purchaseFixture(db);
      const b = await purchaseFixture(db);
      const itemId = randomUUID();
      const [connection] = await db
        .insert(externalConnections)
        .values({ userId: a.user.id, itemId, name: 'Fixture' })
        .returning();
      const secret = 'fixture-webhook-secret-32-characters';
      const event = {
        eventId: randomUUID(),
        event: 'transactions/created',
        itemId,
        accountId: randomUUID(),
        transactionsCreatedAtFrom: '2026-09-28T10:00:00Z',
        transactionsMinDate: '2026-08-01',
        clientUserId: b.user.id,
        createdTransactionsLink: 'https://private.invalid/secret',
      };
      const request = (token: string, body: unknown = event) =>
        new Request('https://fixture.test/api/integrations/pluggy/webhook', {
          method: 'POST',
          headers: { 'x-pluggy-secret': token, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await handlePluggyWebhook(request('wrong'), db, secret)).status).toBe(401);
      await db.execute(sql`SET LOCAL ROLE integration_scheduler`);
      expect((await handlePluggyWebhook(request(secret), db, secret)).status).toBe(202);
      expect((await handlePluggyWebhook(request(secret), db, secret)).status).toBe(202);
      expect(
        (
          await handlePluggyWebhook(
            request(secret, { ...event, eventId: randomUUID(), itemId: randomUUID() }),
            db,
            secret,
          )
        ).status,
      ).toBe(202);
      expect(
        (await handlePluggyWebhook(request(secret, { ...event, event: 'unknown' }), db, secret))
          .status,
      ).toBe(400);
      expect(
        (await handlePluggyWebhook(request(secret, { oversized: 'x'.repeat(70_000) }), db, secret))
          .status,
      ).toBe(413);
      await db.execute(sql`RESET ROLE`);
      const jobs = await db.select().from(integrationJobs);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        userId: a.user.id,
        connectionId: connection.id,
        idempotencyKey: `event:${event.eventId}`,
        payload: {
          event: event.event,
          accountId: event.accountId,
          transactionIds: [],
          transactionsCreatedAtFrom: '2026-09-28T10:00:00.000Z',
          transactionsMinDate: '2026-08-01',
        },
      });
      expect(JSON.stringify(jobs[0].payload)).not.toContain('private.invalid');
      expect(JSON.stringify(jobs[0].payload)).not.toContain(b.user.id);
    });
  });
});
