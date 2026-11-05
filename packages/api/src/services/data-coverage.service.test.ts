import { randomUUID } from 'node:crypto';
import { externalAccounts, externalConnections, faturaImports, financialEvents } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { CaptureDeviceService } from './capture-device.service.ts';
import { DataCoverageService } from './data-coverage.service.ts';
import { FinancialEventService } from './financial-event.service.ts';
import { PurchaseInboxService } from './purchase-inbox.service.ts';

describe('DataCoverageService', () => {
  it('separates completed fetch and institution update while retaining partial and paused coverage', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db),
        sourceAt = new Date('2026-09-25'),
        fetchedAt = new Date('2026-09-28');
      const [connection] = await db
        .insert(externalConnections)
        .values({
          userId: f.user.id,
          itemId: randomUUID(),
          name: 'Fixture',
          sourceUpdatedAt: sourceAt,
        })
        .returning();
      await db.insert(externalAccounts).values({
        userId: f.user.id,
        connectionId: connection.id,
        externalId: randomUUID(),
        accountId: f.card.id,
        kind: 'CREDIT',
        name: 'Fixture',
        currency: 'BRL',
        fetchedAt,
      });
      const service = new DataCoverageService(db, () => fetchedAt, false, true);
      const get = async () =>
        (await service.get(f.user.id))[0].sources.find((s) => s.source === 'pluggy');
      expect(await get()).toMatchObject({
        active: true,
        lastSuccessfulFetchAt: null,
        coveredThrough: null,
      });
      await db
        .update(externalConnections)
        .set({ lastFetchedAt: fetchedAt })
        .where(eq(externalConnections.id, connection.id));
      expect(await get()).toMatchObject({
        lastSuccessfulFetchAt: fetchedAt,
        providerUpdatedAt: sourceAt,
        state: 'partial',
        coveredThrough: null,
      });
      await db
        .update(externalConnections)
        .set({ status: 'paused' })
        .where(eq(externalConnections.id, connection.id));
      expect(await get()).toMatchObject({
        active: false,
        state: 'disabled',
        lastSuccessfulFetchAt: fetchedAt,
      });
    });
  });
  it('reports an authorized Android channel without claiming coverage and disables it on revocation', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const capture = new CaptureDeviceService(db);
      const code = await capture.createPairing(f.user.id, { name: 'Fixture phone' });
      const paired = await capture.pair({ code: code.code });
      const coverage = new DataCoverageService(db, () => new Date(), true);
      const [before] = await coverage.get(f.user.id);
      expect(before.sources.find((s) => s.source === 'android')).toMatchObject({
        active: true,
        state: 'no_data',
        coveredThrough: null,
        lastSuccessfulFetchAt: null,
      });
      await capture.revoke(f.user.id, paired.deviceId);
      const [after] = await coverage.get(f.user.id);
      expect(after.sources.find((s) => s.source === 'android')?.state).toBe('disabled');
    });
  });
  it('distinguishes no data, partial receipts, stale receipts and disabled sources without claiming a fetch', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const now = new Date('2026-09-26T15:00:00Z');
      const service = new DataCoverageService(db, () => now);
      const [empty] = await service.get(f.user.id);
      expect(empty).toMatchObject({ cardAccountId: f.card.id, state: 'no_data', pending: 0 });
      expect(empty.sources.find((s) => s.source === 'pluggy')).toMatchObject({
        active: false,
        state: 'disabled',
        lastSuccessfulFetchAt: null,
        providerUpdatedAt: null,
      });
      await new FinancialEventService(db).ingest(f.user.id, f.event);
      await db
        .update(financialEvents)
        .set({ lastReceivedAt: now })
        .where(eq(financialEvents.userId, f.user.id));
      const [partial] = await service.get(f.user.id);
      expect(partial).toMatchObject({ state: 'partial', pending: 1 });
      expect(partial.sources.find((s) => s.source === 'manual')).toMatchObject({
        lastEventReceivedAt: now,
        lastSuccessfulFetchAt: null,
        coveredThrough: null,
      });
      const [stale] = await new DataCoverageService(db, () => new Date('2026-10-10')).get(
        f.user.id,
      );
      expect(stale.state).toBe('stale');
    });
  });

  it('scopes reconciled PDF cycles, exposes later differences and never marks the open cycle current', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const other = await purchaseFixture(db);
      const base = {
        userId: f.user.id,
        cardAccountId: f.card.id,
        billingMonth: 8,
        billingYear: 2026,
        dueDate: '2026-09-08',
        closingDate: '2026-08-24',
        closingDateSource: 'institution' as const,
        periodConfidence: 'confirmed' as const,
        status: 'applied',
        profileId: 'fixture',
        modelUsed: 'fixture',
        parsedTotal: '100.00',
        appliedAt: new Date('2026-09-25T12:00:00Z'),
        itemsJson: {
          cardAccounts: [],
          matchResult: { matched: [], review: [], newOnFatura: [], missingInSystem: [] },
          suggestions: [],
          totals: {
            chargesTotal: '100.00',
            refundsTotal: '0.00',
            netTotal: '100.00',
            delta: '0.00',
          },
          reconciliation: {
            status: 'reconciled' as const,
            compositionDelta: '0.00',
            documentDelta: '0.00',
            future: false,
            estimated: false,
          },
        },
      };
      await db.insert(faturaImports).values(base);
      const service = new DataCoverageService(db, () => new Date('2026-09-26'));
      const [coverage] = await service.get(f.user.id);
      expect(coverage.state).toBe('partial');
      expect(coverage.lastReconciledCycle).toMatchObject({
        month: 8,
        year: 2026,
        closingDate: '2026-08-24',
      });
      expect(coverage.sources.find((s) => s.source === 'pdf')).toMatchObject({
        lastEventReceivedAt: null,
        lastSuccessfulFetchAt: null,
        coveredFrom: null,
        coveredThrough: '2026-08-24',
      });
      await db.insert(faturaImports).values({
        ...base,
        billingMonth: 9,
        closingDate: '2026-09-24',
        dueDate: '2026-10-08',
        appliedAt: new Date('2026-09-26T12:00:00Z'),
        itemsJson: {
          ...base.itemsJson,
          reconciliation: { ...base.itemsJson.reconciliation, status: 'difference' },
        },
      });
      const [difference] = await service.get(f.user.id);
      expect(difference.sources.find((s) => s.source === 'pdf')).toMatchObject({
        state: 'error',
        error: 'reconciliation_difference',
      });
      expect(difference.lastReconciledCycle?.month).toBe(8);
      await expect(service.get(other.user.id, f.card.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', ${other.user.id}, true)`);
      expect((await service.get(other.user.id)).map((row) => row.cardAccountId)).toEqual([
        other.card.id,
      ]);
      expect(await service.get(f.user.id)).toEqual([]);
    });
  });

  it('reports only aggregate operational counts and observed delays without financial payloads', async () => {
    await withRollback(async (db) => {
      const f = await purchaseFixture(db);
      const events = new FinancialEventService(db);
      const inbox = new PurchaseInboxService(db);
      const { observation } = await events.ingest(f.user.id, f.event);
      await events.ingest(f.user.id, f.event);
      const corrected = await inbox.review(f.user.id, {
        observationId: observation.id,
        version: 1,
        changes: { description: 'Private merchant corrected' },
      });
      const applied = await inbox.accept(f.user.id, {
        observationId: observation.id,
        version: corrected.version,
        expenseAccountId: f.expense.id,
        billingMonth: 9,
        billingYear: 2026,
      });
      const duplicate = await events.ingest(f.user.id, {
        ...f.event,
        source: 'pdf',
        externalId: 'statement-row',
      });
      if (!applied.link?.scheduleId) throw new Error('Missing installment link');
      await inbox.link(f.user.id, {
        observationId: duplicate.observation.id,
        version: duplicate.observation.version,
        target: { scheduleId: applied.link.scheduleId },
      });
      const metrics = await new DataCoverageService(db).metrics(f.user.id);
      expect(metrics).toMatchObject({
        captured: 2,
        accepted: 1,
        corrected: 1,
        confirmedDuplicates: 1,
        revisionCount: 2,
      });
      expect(metrics.reviewDelayMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(metrics).sort()).toEqual(
        [
          'accepted',
          'captured',
          'confirmedDuplicates',
          'corrected',
          'latencyMs',
          'latencySamples',
          'reviewDelayMs',
          'reviewSamples',
          'revisionCount',
        ].sort(),
      );
      expect(
        Object.values(metrics).every((value) => value === null || typeof value === 'number'),
      ).toBe(true);
      const other = await purchaseFixture(db);
      expect(await new DataCoverageService(db).metrics(other.user.id)).toMatchObject({
        captured: 0,
        accepted: 0,
        corrected: 0,
        confirmedDuplicates: 0,
      });
    });
  });
});
