import { randomUUID } from 'node:crypto';
import { captureDevices, capturePairingCodes, purchaseObservations, transactions } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { CaptureDeviceService } from './capture-device.service.ts';

describe('CaptureDeviceService', () => {
  async function setup(db: Parameters<Parameters<typeof withRollback>[0]>[0]) {
    const f = await purchaseFixture(db);
    const service = new CaptureDeviceService(db);
    const code = await service.createPairing(f.user.id, { name: 'Fixture phone' });
    const paired = await service.pair({ code: code.code });
    const envelope = {
      version: 1,
      events: [
        {
          id: randomUUID(),
          revision: 1,
          parserVersion: 'fixture-1',
          observedAt: new Date().toISOString(),
          data: f.event.data,
        },
      ],
    };
    return { f, service, code, paired, envelope };
  }
  it('consumes pairing once, replays events and never changes the financial ledger', async () => {
    await withRollback(async (db) => {
      const { f, service, code, paired, envelope } = await setup(db);
      await expect(service.pair({ code: code.code })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      const first = await service.ingest(paired.token, envelope);
      const retry = await service.ingest(paired.token, envelope);
      expect(first.acknowledgements[0]).toMatchObject({
        id: envelope.events[0]?.id,
        revision: 1,
        replayed: false,
      });
      expect(retry.acknowledgements[0]).toMatchObject({
        observationId: first.acknowledgements[0]?.observationId,
        replayed: true,
      });
      expect(
        await db
          .select()
          .from(purchaseObservations)
          .where(eq(purchaseObservations.userId, f.user.id)),
      ).toHaveLength(1);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(0);
    });
  });
  it('keeps bank, wallet and shared SMS evidence separate and replays only the same UUID', async () => {
    await withRollback(async (db) => {
      const { f, service, paired, envelope } = await setup(db);
      const events = ['bank', 'wallet', 'shared_sms'].map((channel) => ({
        ...envelope.events[0],
        id: randomUUID(),
        parserVersion: `fixture-${channel}-1`,
      }));
      const first = await service.ingest(paired.token, { version: 1, events });
      const retry = await service.ingest(paired.token, { version: 1, events });
      expect(new Set(first.acknowledgements.map((ack) => ack.observationId)).size).toBe(3);
      expect(retry.acknowledgements.every((ack) => ack.replayed)).toBe(true);
      expect(
        await db
          .select()
          .from(purchaseObservations)
          .where(eq(purchaseObservations.userId, f.user.id)),
      ).toHaveLength(3);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(0);
    });
  });
  it('rolls back an entire batch if one event claims a foreign card', async () => {
    await withRollback(async (db) => {
      const { f, service, paired, envelope } = await setup(db);
      const other = await purchaseFixture(db);
      const events = [
        envelope.events[0],
        {
          ...envelope.events[0],
          id: randomUUID(),
          data: { ...f.event.data, cardAccountId: other.card.id },
        },
      ];
      await expect(service.ingest(paired.token, { version: 1, events })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(
        await db
          .select()
          .from(purchaseObservations)
          .where(eq(purchaseObservations.userId, f.user.id)),
      ).toHaveLength(0);
    });
  });
  it('rejects another owner card or device and protects owner resolution with app_user RLS', async () => {
    await withRollback(async (db) => {
      const { f, service, paired, envelope } = await setup(db);
      const other = await purchaseFixture(db);
      await expect(
        service.createPairing(other.user.id, { name: 'Other', deviceId: paired.deviceId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.revoke(other.user.id, paired.deviceId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        service.ingest(paired.token, {
          ...envelope,
          events: [
            { ...envelope.events[0], data: { ...f.event.data, cardAccountId: other.card.id } },
          ],
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', '', true)`);
      expect(await db.select().from(captureDevices)).toHaveLength(0);
      const accepted = await new CaptureDeviceService(db).ingest(paired.token, envelope);
      expect(accepted.acknowledgements).toHaveLength(1);
    });
  });
  it('expires codes and tokens, revokes immediately and rotates without changing event identity', async () => {
    await withRollback(async (db) => {
      const { f, service, paired, envelope } = await setup(db);
      const first = await service.ingest(paired.token, envelope);
      await service.revoke(f.user.id, paired.deviceId);
      await expect(service.ingest(paired.token, envelope)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      const replacement = await service.createPairing(f.user.id, {
        name: 'Same phone',
        deviceId: paired.deviceId,
      });
      const rotated = await service.pair({ code: replacement.code });
      expect(rotated.deviceId).toBe(paired.deviceId);
      expect(rotated.token).not.toBe(paired.token);
      await expect(service.ingest(paired.token, envelope)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      expect(
        (await service.ingest(rotated.token, envelope)).acknowledgements[0]?.observationId,
      ).toBe(first.acknowledgements[0]?.observationId);
      await db
        .update(captureDevices)
        .set({ expiresAt: new Date(0) })
        .where(eq(captureDevices.id, paired.deviceId));
      await expect(service.ingest(rotated.token, envelope)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      const expired = await service.createPairing(f.user.id, { name: 'Expired' });
      await db
        .update(capturePairingCodes)
        .set({ expiresAt: new Date(0) })
        .where(eq(capturePairingCodes.userId, f.user.id));
      await expect(service.pair({ code: expired.code })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
  it('rejects identity spoofing, raw text, malformed revisions and out-of-window observations', async () => {
    await withRollback(async (db) => {
      const { service, paired, envelope } = await setup(db);
      for (const input of [
        { ...envelope, userId: randomUUID() },
        { ...envelope, events: [{ ...envelope.events[0], rawText: 'OTP secret' }] },
        { ...envelope, events: [{ ...envelope.events[0], revision: 0 }] },
        { ...envelope, events: [{ ...envelope.events[0], observedAt: '2020-01-01T00:00:00Z' }] },
        {
          ...envelope,
          events: [
            { ...envelope.events[0], observedAt: new Date(Date.now() + 3600_000).toISOString() },
          ],
        },
      ])
        await expect(service.ingest(paired.token, input)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
    });
  });
  it('enforces durable per-device and anonymous limits across service instances', async () => {
    await withRollback(async (db) => {
      const { service, paired, envelope } = await setup(db);
      await db
        .update(captureDevices)
        .set({ rateCount: 120, rateWindowAt: new Date() })
        .where(eq(captureDevices.id, paired.deviceId));
      await expect(
        new CaptureDeviceService(db).ingest(paired.token, envelope),
      ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      await db.execute(
        sql`UPDATE capture_ingress_buckets SET attempts = 1000, window_at = clock_timestamp() WHERE bucket = 'events'`,
      );
      await expect(service.ingest('bad', envelope)).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      });
    });
  });
  it('issues a short-lived high-entropy one-time code and only stores its digest', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const result = await new CaptureDeviceService(db).createPairing(f.user.id, {
        name: 'Fixture phone',
      });
      expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.expiresAt.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(result.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
      const rows = await db
        .select()
        .from(capturePairingCodes)
        .where(eq(capturePairingCodes.userId, f.user.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.codeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(rows)).not.toContain(result.code);
    });
  });
});
