import type { DbExecutor } from '@fc/db';
import {
  accounts,
  auditLog,
  captureDevices,
  externalAccounts,
  externalConnections,
  faturaImports,
  financialEventRevisions,
  financialEvents,
  purchaseLedgerLinks,
  purchaseObservations,
} from '@fc/db';
import type { FinancialEventSource } from '@fc/shared';
import { TRPCError } from '@trpc/server';
import { and, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { logger } from '../lib/logger.ts';

const SOURCES: readonly FinancialEventSource[] = ['manual', 'pdf', 'android', 'pluggy'];
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
type ReceiptState = 'no_data' | 'partial' | 'stale';

export class DataCoverageService {
  constructor(
    private db: DbExecutor,
    private now: () => Date = () => new Date(),
    private androidEnabled = process.env.CAPTURE_ANDROID_ENABLED === 'true',
    private pluggyEnabled = process.env.PLUGGY_ENABLED === 'true',
  ) {}

  private statements(userId: string, cardIds: string[], reconciledOnly: boolean) {
    return this.db
      .selectDistinctOn([accounts.id], {
        cardAccountId: accounts.id,
        month: faturaImports.billingMonth,
        year: faturaImports.billingYear,
        closingDate: faturaImports.closingDate,
        appliedAt: faturaImports.appliedAt,
        confidence: faturaImports.periodConfidence,
        status: sql<
          'reconciled' | 'difference' | 'unknown' | null
        >`${faturaImports.itemsJson}->'reconciliation'->>'status'`,
        estimated: sql<
          boolean | null
        >`(${faturaImports.itemsJson}->'reconciliation'->>'estimated')::boolean`,
        future: sql<
          boolean | null
        >`(${faturaImports.itemsJson}->'reconciliation'->>'future')::boolean`,
      })
      .from(accounts)
      .innerJoin(
        faturaImports,
        and(
          eq(faturaImports.userId, userId),
          or(
            eq(faturaImports.cardAccountId, accounts.id),
            sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${faturaImports.itemsJson}->'cardAccounts') item WHERE item->>'id' = ${accounts.id}::text)`,
          ),
        ),
      )
      .where(
        and(
          eq(accounts.userId, userId),
          inArray(accounts.id, cardIds),
          eq(faturaImports.status, 'applied'),
          reconciledOnly
            ? sql`${faturaImports.itemsJson}->'reconciliation'->>'status' = 'reconciled'`
            : undefined,
        ),
      )
      .orderBy(accounts.id, desc(faturaImports.appliedAt), desc(faturaImports.id));
  }

  async get(userId: string, cardAccountId?: string) {
    const cards = await this.db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
          cardAccountId ? eq(accounts.id, cardAccountId) : undefined,
        ),
      );
    if (cardAccountId && cards.length === 0)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Card not found' });
    if (cards.length === 0) return [];
    const ids = cards.map((card) => card.id);
    const [receipts, pending, latest, reconciled, devices, integrations] = await Promise.all([
      this.db
        .select({
          cardAccountId: purchaseObservations.cardAccountId,
          source: financialEvents.source,
          lastReceivedAt: sql<string>`max(${financialEvents.lastReceivedAt})`,
        })
        .from(financialEvents)
        .innerJoin(
          purchaseObservations,
          and(
            eq(purchaseObservations.id, financialEvents.observationId),
            eq(purchaseObservations.userId, userId),
          ),
        )
        .where(
          and(eq(financialEvents.userId, userId), inArray(purchaseObservations.cardAccountId, ids)),
        )
        .groupBy(purchaseObservations.cardAccountId, financialEvents.source),
      this.db
        .select({ cardAccountId: purchaseObservations.cardAccountId, count: count() })
        .from(purchaseObservations)
        .where(
          and(
            eq(purchaseObservations.userId, userId),
            isNull(purchaseObservations.mergedIntoId),
            inArray(purchaseObservations.cardAccountId, ids),
            inArray(purchaseObservations.review, ['unreviewed', 'needs_review']),
          ),
        )
        .groupBy(purchaseObservations.cardAccountId),
      this.statements(userId, ids, false),
      this.statements(userId, ids, true),
      this.db
        .select({ id: captureDevices.id })
        .from(captureDevices)
        .where(
          and(
            eq(captureDevices.userId, userId),
            isNull(captureDevices.revokedAt),
            gt(captureDevices.expiresAt, this.now()),
          ),
        )
        .limit(1),
      this.db
        .select({ cardAccountId: externalAccounts.accountId, connection: externalConnections })
        .from(externalAccounts)
        .innerJoin(
          externalConnections,
          and(
            eq(externalConnections.userId, userId),
            eq(externalConnections.id, externalAccounts.connectionId),
          ),
        )
        .where(and(eq(externalAccounts.userId, userId), inArray(externalAccounts.accountId, ids))),
    ]);
    const now = this.now().getTime();
    function receiptState(date: Date | null): ReceiptState {
      if (!date) return 'no_data';
      return now - date.getTime() > STALE_AFTER_MS ? 'stale' : 'partial';
    }
    return cards.map((card) => {
      const statement = latest.find((row) => row.cardAccountId === card.id) ?? null;
      const cycle = reconciled.find((row) => row.cardAccountId === card.id) ?? null;
      const sources = SOURCES.map((source) => {
        const connection =
          source === 'pluggy'
            ? integrations.find((row) => row.cardAccountId === card.id)?.connection
            : undefined;
        const received = receipts.find(
          (row) => row.cardAccountId === card.id && row.source === source,
        );
        const lastEventReceivedAt = received ? new Date(received.lastReceivedAt) : null;
        const lastImportAppliedAt = source === 'pdf' ? (statement?.appliedAt ?? null) : null;
        const lastActivity =
          [lastEventReceivedAt, lastImportAppliedAt]
            .filter((date): date is Date => date !== null)
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        const active =
          source === 'manual' ||
          source === 'pdf' ||
          (source === 'android' && this.androidEnabled && devices.length > 0) ||
          (source === 'pluggy' && this.pluggyEnabled && connection?.status === 'active');
        const error =
          source === 'pdf' && statement?.status === 'difference'
            ? ('reconciliation_difference' as const)
            : source === 'pluggy'
              ? (connection?.errorCode ??
                (connection?.status === 'auth_required' ? 'authorization_required' : null))
              : null;
        return {
          source,
          active,
          lastEventReceivedAt,
          lastImportAppliedAt,
          lastSuccessfulFetchAt: connection?.lastFetchedAt ?? null,
          providerUpdatedAt: connection?.sourceUpdatedAt ?? null,
          coveredFrom: null,
          coveredThrough:
            source === 'pdf' &&
            cycle?.confidence === 'confirmed' &&
            cycle.estimated === false &&
            cycle.future === false
              ? cycle.closingDate
              : null,
          error,
          state:
            error && this.pluggyEnabled && connection?.status !== 'paused'
              ? ('error' as const)
              : !active
                ? ('disabled' as const)
                : error
                  ? ('error' as const)
                  : receiptState(
                      connection?.sourceUpdatedAt ?? connection?.lastFetchedAt ?? lastActivity,
                    ),
        };
      });
      const lastActivity =
        sources
          .flatMap((source) => [
            source.lastEventReceivedAt,
            source.lastImportAppliedAt,
            source.providerUpdatedAt ?? source.lastSuccessfulFetchAt,
          ])
          .filter((date): date is Date => date !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return {
        cardAccountId: card.id,
        cardName: card.name,
        state: receiptState(lastActivity),
        pending: pending.find((row) => row.cardAccountId === card.id)?.count ?? 0,
        lastReconciledCycle: cycle,
        sources,
      };
    });
  }

  async metrics(userId: string) {
    const [captures, accepted, decisions, latency, review] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(financialEvents)
        .where(eq(financialEvents.userId, userId)),
      this.db
        .select({ value: sql<number>`count(distinct ${purchaseLedgerLinks.observationId})::int` })
        .from(purchaseLedgerLinks)
        .where(eq(purchaseLedgerLinks.userId, userId)),
      this.db
        .select({
          corrected: sql<number>`count(*) FILTER (WHERE ${auditLog.action} = 'review' AND (${auditLog.newData} - ARRAY['version','updatedAt','review','unrecognized']) IS DISTINCT FROM (${auditLog.previousData} - ARRAY['version','updatedAt','review','unrecognized']))::int`,
          duplicates: sql<number>`count(*) FILTER (WHERE ${auditLog.action} = 'merge_evidence')::int`,
        })
        .from(auditLog)
        .where(and(eq(auditLog.userId, userId), eq(auditLog.entityType, 'purchase_observation'))),
      this.db
        .select({
          count: count(),
          samples: sql<number>`count(*) FILTER (WHERE ${financialEventRevisions.receivedAt} >= ${financialEventRevisions.observedAt})::int`,
          ms: sql<
            string | null
          >`avg(extract(epoch from (${financialEventRevisions.receivedAt}-${financialEventRevisions.observedAt}))*1000) FILTER (WHERE ${financialEventRevisions.receivedAt} >= ${financialEventRevisions.observedAt})`,
        })
        .from(financialEventRevisions)
        .where(eq(financialEventRevisions.userId, userId)),
      this.db.execute<{ samples: number; ms: string | null }>(sql`
        SELECT count(*)::int AS samples, avg(extract(epoch from (first_decision - created_at))*1000) AS ms
        FROM (SELECT p.id, p.created_at, min(a.created_at) AS first_decision
          FROM purchase_observations p JOIN audit_log a ON a.entity_id=p.id AND a.user_id=${userId} AND a.entity_type='purchase_observation' AND a.action IN ('link','review','ignore','acknowledge')
          WHERE p.user_id=${userId} GROUP BY p.id, p.created_at) decisions
        WHERE first_decision >= created_at`),
    ]);
    const metrics = {
      captured: captures[0]?.value ?? 0,
      accepted: accepted[0]?.value ?? 0,
      corrected: decisions[0]?.corrected ?? 0,
      confirmedDuplicates: decisions[0]?.duplicates ?? 0,
      revisionCount: latency[0]?.count ?? 0,
      latencySamples: latency[0]?.samples ?? 0,
      latencyMs: latency[0]?.ms == null ? null : Number(latency[0].ms),
      reviewSamples: review[0]?.samples ?? 0,
      reviewDelayMs: review[0]?.ms == null ? null : Number(review[0].ms),
    };
    logger.info(
      { event: 'purchase_inbox.metrics_snapshot', ...metrics },
      'purchase_inbox.metrics_snapshot',
    );
    return metrics;
  }
}
