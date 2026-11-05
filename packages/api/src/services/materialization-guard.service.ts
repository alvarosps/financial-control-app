import type { DbExecutor } from '@fc/db';
import { materializationStatus, scheduledTransactions } from '@fc/db';
import { and, eq, sql } from 'drizzle-orm';

import { toIso } from '../lib/calendar-dates.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { MaterializerService } from './materializer.service.ts';

export type MaterializationReason =
  | 'missing'
  | 'horizon'
  | 'schedule_hash'
  | 'repair_ttl'
  | 'legacy_hash';

export type MaterializationState = {
  currentHash: string;
  existingStatus: {
    horizonEnd: string;
    schedulesHash: string;
    lastMaterializedAt: Date;
  } | null;
};

export type MaterializationDecision = {
  reason: MaterializationReason | null;
  mode: 'none' | 'full-fill' | 'full-rebuild';
};

export class MaterializationGuard {
  static readonly CACHE_TTL_MS = 60 * 60 * 1000;

  constructor(private db: DbExecutor) {}

  static buildHash(count: number, maxUpdated: string | null, maxCreated: string | null): string {
    return `${count}|${maxUpdated ?? ''}|${maxCreated ?? ''}`;
  }

  static isLegacyHash(value: string): boolean {
    return /^\d+\|/.test(value);
  }

  static lastDayOfMonth(month: number, year: number): string {
    const lastDay = new Date(year, month, 0).getDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  }

  static decision(
    status: MaterializationState['existingStatus'],
    targetMonth: number,
    targetYear: number,
    currentHash: string,
    now: Date = new Date(),
  ): MaterializationDecision {
    if (status === null) return { reason: 'missing', mode: 'full-rebuild' };
    if (MaterializationGuard.isLegacyHash(status.schedulesHash)) {
      return { reason: 'legacy_hash', mode: 'full-fill' };
    }
    if (status.schedulesHash !== currentHash) {
      return { reason: 'schedule_hash', mode: 'full-rebuild' };
    }
    if (status.horizonEnd < MaterializationGuard.lastDayOfMonth(targetMonth, targetYear)) {
      return { reason: 'horizon', mode: 'full-fill' };
    }
    if (now.getTime() - status.lastMaterializedAt.getTime() > MaterializationGuard.CACHE_TTL_MS) {
      return { reason: 'repair_ttl', mode: 'full-fill' };
    }
    return { reason: null, mode: 'none' };
  }

  static needsMaterialization(
    status: MaterializationState['existingStatus'],
    targetMonth: number,
    targetYear: number,
    currentHash: string,
  ): boolean {
    return (
      MaterializationGuard.decision(status, targetMonth, targetYear, currentHash).reason !== null
    );
  }

  async readState(exec: DbExecutor, userId: string): Promise<MaterializationState> {
    const [hashResult] = await exec
      .select({
        fingerprint: sql<string>`md5(COALESCE(string_agg(md5(to_jsonb(${scheduledTransactions})::text), '' ORDER BY ${scheduledTransactions.id}), ''))`,
      })
      .from(scheduledTransactions)
      .where(
        and(eq(scheduledTransactions.userId, userId), eq(scheduledTransactions.isActive, true)),
      );
    const [existingStatus] = await exec
      .select({
        horizonEnd: materializationStatus.horizonEnd,
        schedulesHash: materializationStatus.schedulesHash,
        lastMaterializedAt: materializationStatus.lastMaterializedAt,
      })
      .from(materializationStatus)
      .where(eq(materializationStatus.userId, userId));

    return {
      currentHash: hashResult?.fingerprint ?? '',
      existingStatus: existingStatus ?? null,
    };
  }

  async upsertStatus(
    exec: DbExecutor,
    userId: string,
    currentHash: string,
    horizonEnd: Date,
    now: Date = new Date(),
  ): Promise<void> {
    await exec
      .insert(materializationStatus)
      .values({
        userId,
        lastMaterializedAt: now,
        horizonEnd: toIso(horizonEnd),
        schedulesHash: currentHash,
      })
      .onConflictDoUpdate({
        target: materializationStatus.userId,
        set: {
          lastMaterializedAt: now,
          horizonEnd: toIso(horizonEnd),
          schedulesHash: currentHash,
        },
      });
  }

  async ensureMaterialized(userId: string, targetMonth: number, targetYear: number): Promise<void> {
    const pre = await this.readState(this.db, userId);
    if (
      MaterializationGuard.decision(pre.existingStatus, targetMonth, targetYear, pre.currentHash)
        .reason === null
    ) {
      return;
    }

    await runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const state = await this.readState(db, userId);
      const decision = MaterializationGuard.decision(
        state.existingStatus,
        targetMonth,
        targetYear,
        state.currentHash,
      );
      if (decision.reason === null) return;

      const now = new Date();
      const baselineEnd = new Date(now.getFullYear(), now.getMonth() + 12, 0);
      const targetEnd = new Date(targetYear, targetMonth, 0);
      const horizonEnd = baselineEnd > targetEnd ? baselineEnd : targetEnd;
      const horizonMonths = Math.max(
        12,
        (horizonEnd.getFullYear() - now.getFullYear()) * 12 +
          (horizonEnd.getMonth() - now.getMonth()) +
          1,
      );
      const materializer = new MaterializerService(db);
      await materializer.materializeScheduleChanges(userId, {
        scope: decision.mode === 'full-rebuild' ? 'full-rebuild' : 'full-fill',
        fillScheduleIds: [],
        rebuildScheduleIds: [],
        horizonMonths,
      });
      const post = await this.readState(db, userId);
      await this.upsertStatus(db, userId, post.currentHash, horizonEnd, now);
    });
  }
}
