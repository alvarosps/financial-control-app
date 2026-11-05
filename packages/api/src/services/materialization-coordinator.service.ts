import type { DbExecutor } from '@fc/db';
import { transactions } from '@fc/db';
import { and, eq, sql } from 'drizzle-orm';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { openCardPeriod } from '../lib/open-card-period.ts';
import {
  MaterializationGuard,
  type MaterializationState,
} from './materialization-guard.service.ts';
import { type MaterializeResult, MaterializerService } from './materializer.service.ts';

const checkpointBrand = Symbol('schedule-change-checkpoint');

export type ScheduleChangeCheckpoint = {
  readonly userId: string;
  readonly state: MaterializationState;
  readonly capturedAt: Date;
  readonly [checkpointBrand]: true;
};

/**
 * Collects schedule changes made by one larger write and materializes them once
 * after that write has finished. This keeps multi-item fatura applies from
 * rebuilding the same user horizon for every individual decision.
 */
export class MaterializationBatch {
  private readonly fillScheduleIds = new Set<string>();
  private readonly rebuildScheduleIds = new Set<string>();
  private minimumHorizonMonths = 12;
  private finalized = false;
  private readonly paidBefore = new Map<string, { month: number; year: number }>();

  constructor(
    private readonly coordinator: MaterializationCoordinator,
    private readonly checkpoint: ScheduleChangeCheckpoint,
  ) {}

  addFill(scheduleId: string, minimumHorizonMonths: number): void {
    this.assertOpen();
    this.fillScheduleIds.add(scheduleId);
    this.minimumHorizonMonths = Math.max(this.minimumHorizonMonths, minimumHorizonMonths);
  }

  addRebuild(scheduleId: string, minimumHorizonMonths: number): void {
    this.assertOpen();
    this.rebuildScheduleIds.add(scheduleId);
    this.minimumHorizonMonths = Math.max(this.minimumHorizonMonths, minimumHorizonMonths);
  }

  deferFill(scheduleId: string, minimumHorizonMonths: number): MaterializeResult {
    this.addFill(scheduleId, minimumHorizonMonths);
    return this.deferredResult();
  }

  deferRebuild(scheduleId: string, minimumHorizonMonths: number): MaterializeResult {
    this.addRebuild(scheduleId, minimumHorizonMonths);
    return this.deferredResult();
  }

  settleInstallmentsBefore(scheduleId: string, period: { month: number; year: number }): void {
    this.assertOpen();
    this.paidBefore.set(scheduleId, period);
  }

  deferredResult(): MaterializeResult {
    return {
      created: 0,
      skipped: 0,
      invalidSchedules: [],
      scope: 'targeted',
      schedulesLoaded: 0,
      existingRowsLoaded: 0,
      manualRowsLoaded: 0,
      candidateOccurrences: 0,
      closedPeriodSkipped: 0,
      inactiveAccountSkipped: 0,
    };
  }

  async finalize(): Promise<MaterializeResult> {
    this.assertOpen();
    this.finalized = true;
    if (this.fillScheduleIds.size === 0 && this.rebuildScheduleIds.size === 0) {
      return this.deferredResult();
    }
    const result = await this.coordinator.finalizeScheduleChanges({
      checkpoint: this.checkpoint,
      fillScheduleIds: [...this.fillScheduleIds],
      rebuildScheduleIds: [...this.rebuildScheduleIds],
      minimumHorizonMonths: this.minimumHorizonMonths,
    });
    for (const [scheduleId, period] of this.paidBefore) {
      await this.coordinator.settleInstallmentsBefore(this.checkpoint.userId, scheduleId, period);
    }
    return result;
  }

  private assertOpen(): void {
    if (this.finalized) throw new Error('Materialization batch already finalized');
  }
}

export class MaterializationCoordinator {
  private readonly guard: MaterializationGuard;

  constructor(private readonly db: DbExecutor) {
    this.guard = new MaterializationGuard(db);
  }

  async settleInstallmentsBefore(
    userId: string,
    scheduleId: string,
    period: { month: number; year: number },
  ): Promise<void> {
    await this.db
      .update(transactions)
      .set({ isPaid: true, paidAt: new Date() })
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.scheduledTransactionId, scheduleId),
          eq(transactions.domainType, 'credit_card_installment'),
          eq(transactions.isPaid, false),
          openCardPeriod(),
          sql`(${transactions.billingYear} * 12 + ${transactions.billingMonth}) < ${period.year * 12 + period.month}`,
        ),
      );
  }

  async captureCheckpoint(userId: string): Promise<ScheduleChangeCheckpoint> {
    return runWithMaterializationLock(this.db, userId, async ({ db }) => ({
      userId,
      state: await this.guard.readState(db, userId),
      capturedAt: new Date(),
      [checkpointBrand]: true,
    }));
  }

  async startBatch(userId: string): Promise<MaterializationBatch> {
    return new MaterializationBatch(this, await this.captureCheckpoint(userId));
  }

  async finalizeScheduleChanges(input: {
    checkpoint: ScheduleChangeCheckpoint;
    fillScheduleIds: string[];
    rebuildScheduleIds: string[];
    minimumHorizonMonths: number;
  }): Promise<MaterializeResult> {
    const { checkpoint } = input;
    if (checkpoint.userId.length === 0) {
      throw new Error('Invalid materialization checkpoint');
    }

    return runWithMaterializationLock(this.db, checkpoint.userId, async ({ db }) => {
      const current = await this.guard.readState(db, checkpoint.userId);
      const preDecision = MaterializationGuard.decision(
        checkpoint.state.existingStatus,
        new Date().getMonth() + 1,
        new Date().getFullYear(),
        checkpoint.state.currentHash,
        checkpoint.capturedAt,
      );
      const changed = current.currentHash !== checkpoint.state.currentHash;
      const hasRebuild = input.rebuildScheduleIds.length > 0;
      const hasFill = input.fillScheduleIds.length > 0;
      const materializer = new MaterializerService(db);
      const requestedHorizon = Math.max(12, input.minimumHorizonMonths);
      let materialized: MaterializeResult | null = null;

      if (preDecision.reason !== null) {
        materialized = await materializer.materializeScheduleChanges(checkpoint.userId, {
          scope: preDecision.mode === 'full-rebuild' ? 'full-rebuild' : 'full-fill',
          fillScheduleIds: input.fillScheduleIds,
          rebuildScheduleIds: input.rebuildScheduleIds,
          horizonMonths: requestedHorizon,
        });
      } else if (changed && (hasFill || hasRebuild)) {
        materialized = await materializer.materializeScheduleChanges(checkpoint.userId, {
          scope: 'targeted',
          fillScheduleIds: input.fillScheduleIds,
          rebuildScheduleIds: input.rebuildScheduleIds,
          horizonMonths: requestedHorizon,
        });
      }

      const post = await this.guard.readState(db, checkpoint.userId);
      const now = new Date();
      const horizonEnd = new Date(now.getFullYear(), now.getMonth() + requestedHorizon, 0);
      await this.guard.upsertStatus(db, checkpoint.userId, post.currentHash, horizonEnd, now);
      return (
        materialized ??
        (await materializer.materializeSchedules(checkpoint.userId, [], requestedHorizon))
      );
    });
  }
}
