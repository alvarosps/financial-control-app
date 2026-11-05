import { createHash, timingSafeEqual } from 'node:crypto';
import type { DbExecutor } from '@fc/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertIntegrationRole } from './integration-job.service.ts';

export const integrationPayloadSchema = z.object({
  publishAccountId: z.guid().optional(),
  event: z
    .enum([
      'transactions/created',
      'transactions/updated',
      'transactions/deleted',
      'item/created',
      'item/updated',
      'item/deleted',
      'item/error',
      'item/waiting_user_input',
      'item/login_succeeded',
    ])
    .optional(),
  accountId: z.guid().nullable().optional(),
  transactionIds: z.array(z.guid()).max(500).default([]),
  transactionsCreatedAtFrom: z.string().datetime({ offset: true }).optional(),
  transactionsMinDate: z.string().date().optional(),
});
const webhookSchema = integrationPayloadSchema
  .extend({ eventId: z.guid(), itemId: z.guid() })
  .refine(
    (row) =>
      Boolean(row.event) && (!row.event?.startsWith('transactions/') || Boolean(row.accountId)),
  )
  .refine(
    (row) =>
      !['transactions/updated', 'transactions/deleted'].includes(row.event ?? '') ||
      row.transactionIds.length > 0,
  );

export function integrationSecretMatches(actual: string | null, expected: string) {
  if (expected.length < 32 || !actual || actual.length > 4096) return false;
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}
export function integrationResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function readBody(request: Request) {
  const limit = 65_536;
  if (Number(request.headers.get('content-length')) > limit) throw new Error('BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_BODY');
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('BODY_TOO_LARGE');
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  } catch {
    throw new Error('INVALID_BODY');
  }
}
export async function handlePluggyWebhook(request: Request, db: DbExecutor, secret: string) {
  if (!integrationSecretMatches(request.headers.get('x-pluggy-secret'), secret))
    return integrationResponse({ error: 'UNAUTHORIZED' }, 401);
  if (request.method !== 'POST') return integrationResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    return integrationResponse({ error: 'JSON_REQUIRED' }, 415);
  try {
    await assertIntegrationRole(db, 'integration_scheduler');
    const rate = await db.execute(sql`SELECT take_integration_ingress('webhook') AS allowed`);
    if (!rate[0]?.allowed) return integrationResponse({ error: 'RATE_LIMITED' }, 429);
    const parsed = webhookSchema.safeParse(await readBody(request));
    if (!parsed.success) return integrationResponse({ error: 'INVALID_EVENT' }, 400);
    const event = parsed.data;
    await db.execute(
      sql`SELECT enqueue_integration_webhook(${event.eventId}::uuid, ${event.itemId}::uuid, ${event.event ?? ''}, ${event.accountId ?? null}::uuid, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(event.transactionIds)}::jsonb)::uuid), ${event.transactionsCreatedAtFrom ?? null}::timestamptz, ${event.transactionsMinDate ?? null}::date)`,
    );
    return integrationResponse({ accepted: true }, 202);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'BODY_TOO_LARGE') return integrationResponse({ error: code }, 413);
    if (code === 'INVALID_BODY') return integrationResponse({ error: code }, 400);
    return integrationResponse({ error: 'INTEGRATION_UNAVAILABLE' }, 503);
  }
}
