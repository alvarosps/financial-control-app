import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DbExecutor } from '@fc/db';
import { accounts, captureDevices, capturePairingCodes } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { financialEventDataSchema } from '../lib/purchase-input.ts';
import { FinancialEventService } from './financial-event.service.ts';

const credential = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const pairSchema = z.object({ code: credential }).strict();
export const createCapturePairingSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    deviceId: z.guid().optional(),
  })
  .strict();
export const captureEnvelopeSchema = z
  .object({
    version: z.literal(1),
    events: z
      .array(
        z
          .object({
            id: z.guid(),
            revision: z.number().int().min(1).max(2147483647),
            parserVersion: z.string().min(1).max(80),
            observedAt: z.string().datetime({ offset: true }),
            data: financialEventDataSchema
              .extend({
                confirmation: z.literal('observed'),
                postedDate: z.null(),
              })
              .refine(
                (d) =>
                  (d.installmentNumber === null && d.totalInstallments === null) ||
                  (d.installmentNumber !== null &&
                    d.totalInstallments !== null &&
                    d.installmentNumber <= d.totalInstallments),
              ),
          })
          .strict(),
      )
      .min(1)
      .max(25),
  })
  .strict();

const unauthorized = () =>
  new TRPCError({ code: 'UNAUTHORIZED', message: 'Capture credential is invalid or expired' });
const limited = () =>
  new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Capture request limit reached' });
const invalid = () => new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid capture request' });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class CaptureDeviceService {
  constructor(private db: DbExecutor) {}

  async createPairing(userId: string, input: unknown) {
    const parsed = createCapturePairingSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      if (parsed.data.deviceId) {
        const [device] = await db
          .select({ id: captureDevices.id })
          .from(captureDevices)
          .where(
            and(eq(captureDevices.id, parsed.data.deviceId), eq(captureDevices.userId, userId)),
          );
        if (!device) throw new TRPCError({ code: 'NOT_FOUND' });
      }
      const [recent] = await db
        .select({ total: count() })
        .from(capturePairingCodes)
        .where(
          and(
            eq(capturePairingCodes.userId, userId),
            gt(capturePairingCodes.createdAt, new Date(Date.now() - 60_000)),
          ),
        );
      if ((recent?.total ?? 0) >= 5) throw limited();
      const code = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      await db.insert(capturePairingCodes).values({
        userId,
        name: parsed.data.name,
        deviceId: parsed.data.deviceId,
        codeHash: digest(code),
        expiresAt,
      });
      return { code, expiresAt };
    });
  }

  async list(userId: string) {
    return this.db
      .select({
        id: captureDevices.id,
        name: captureDevices.name,
        createdAt: captureDevices.createdAt,
        expiresAt: captureDevices.expiresAt,
        revokedAt: captureDevices.revokedAt,
        lastReceivedAt: captureDevices.lastReceivedAt,
      })
      .from(captureDevices)
      .where(eq(captureDevices.userId, userId))
      .orderBy(desc(captureDevices.createdAt));
  }

  async revoke(userId: string, deviceId: string) {
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const [device] = await db
        .update(captureDevices)
        .set({ revokedAt: new Date() })
        .where(and(eq(captureDevices.id, deviceId), eq(captureDevices.userId, userId)))
        .returning({ id: captureDevices.id });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND' });
      await db
        .update(capturePairingCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(capturePairingCodes.userId, userId),
            eq(capturePairingCodes.deviceId, deviceId),
            isNull(capturePairingCodes.usedAt),
          ),
        );
      return device;
    });
  }

  async takeIngress(bucket: 'pair' | 'events') {
    const result = await this.db.execute<{ allowed: boolean }>(
      sql`SELECT take_capture_ingress(${bucket}) AS allowed`,
    );
    if (!result[0]?.allowed) throw limited();
  }

  private async resolve(kind: 'pair' | 'events', hash: string) {
    const result = await this.db.execute<{ owner_id: string; credential_id: string }>(
      sql`SELECT * FROM resolve_capture_credential(${kind}, ${hash})`,
    );
    const row = result[0];
    if (!row) throw unauthorized();
    return row;
  }

  async pair(input: unknown, ingressChecked = false) {
    if (!ingressChecked) await this.takeIngress('pair');
    const parsed = pairSchema.safeParse(input);
    if (!parsed.success) throw unauthorized();
    const hash = digest(parsed.data.code);
    const owner = await this.resolve('pair', hash);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${owner.owner_id}, true)`);
      return runWithMaterializationLock(tx, owner.owner_id, async ({ db }) => {
        const now = new Date();
        const [code] = await db
          .update(capturePairingCodes)
          .set({ usedAt: now })
          .where(
            and(
              eq(capturePairingCodes.id, owner.credential_id),
              eq(capturePairingCodes.userId, owner.owner_id),
              eq(capturePairingCodes.codeHash, hash),
              isNull(capturePairingCodes.usedAt),
              gt(capturePairingCodes.expiresAt, now),
            ),
          )
          .returning();
        if (!code) throw unauthorized();
        const token = randomBytes(32).toString('base64url');
        const expiresAt = new Date(now.getTime() + 90 * 86400_000);
        const values = {
          name: code.name,
          tokenHash: digest(token),
          expiresAt,
          revokedAt: null,
          rateCount: 0,
          rateWindowAt: now,
        };
        const [device] = code.deviceId
          ? await db
              .update(captureDevices)
              .set(values)
              .where(
                and(
                  eq(captureDevices.id, code.deviceId),
                  eq(captureDevices.userId, owner.owner_id),
                ),
              )
              .returning({ id: captureDevices.id })
          : await db
              .insert(captureDevices)
              .values({ ...values, userId: owner.owner_id })
              .returning({ id: captureDevices.id });
        if (!device) throw unauthorized();
        const cards = await db
          .select({ id: accounts.id, name: accounts.name })
          .from(accounts)
          .where(and(eq(accounts.userId, owner.owner_id), eq(accounts.type, 'credit_card')));
        return { deviceId: device.id, token, expiresAt, cards };
      });
    });
  }

  async ingest(token: string, input: unknown, ingressChecked = false) {
    if (!ingressChecked) await this.takeIngress('events');
    if (!credential.safeParse(token).success) throw unauthorized();
    const parsed = captureEnvelopeSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const now = Date.now();
    if (
      parsed.data.events.some((e) => {
        const observed = Date.parse(e.observedAt);
        return observed < now - 90 * 86400_000 || observed > now + 5 * 60_000;
      })
    )
      throw invalid();
    const hash = digest(token);
    const owner = await this.resolve('events', hash);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${owner.owner_id}, true)`);
      return runWithMaterializationLock(tx, owner.owner_id, async ({ db }) => {
        const [device] = await db
          .select()
          .from(captureDevices)
          .where(
            and(
              eq(captureDevices.id, owner.credential_id),
              eq(captureDevices.userId, owner.owner_id),
            ),
          )
          .for('update');
        if (
          !device ||
          device.revokedAt ||
          device.expiresAt.getTime() <= Date.now() ||
          !timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(hash))
        )
          throw unauthorized();
        const reset = device.rateWindowAt.getTime() <= now - 60_000;
        if (!reset && device.rateCount >= 120) throw limited();
        await db
          .update(captureDevices)
          .set({
            rateWindowAt: reset ? new Date(now) : device.rateWindowAt,
            rateCount: reset ? 1 : device.rateCount + 1,
            lastReceivedAt: new Date(now),
          })
          .where(and(eq(captureDevices.id, device.id), eq(captureDevices.userId, owner.owner_id)));
        const service = new FinancialEventService(db, ['android']);
        const acknowledgements = [];
        for (const event of parsed.data.events) {
          const captured = await service.ingest(owner.owner_id, {
            source: 'android',
            sourceScope: device.id,
            externalId: event.id,
            sourceVersion: event.revision,
            parserVersion: event.parserVersion,
            observedAt: new Date(event.observedAt),
            data: event.data,
          });
          acknowledgements.push({
            id: event.id,
            revision: event.revision,
            observationId: captured.observation.id,
            replayed: captured.replayed,
          });
        }
        return { acknowledgements };
      });
    });
  }
}
