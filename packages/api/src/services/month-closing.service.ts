import type { DbExecutor } from '@fc/db';
import { monthClosings, monthClosingVersions, transactions } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { AuditService } from './audit.service.ts';
import { FinancialObligationsService } from './financial-obligations.service.ts';
import {
  type ClosingReview,
  closingReviewSchema,
  MonthClosingChecklistService,
} from './month-closing-checklist.service.ts';

export class MonthClosingService {
  constructor(private db: DbExecutor) {}
  private scope(userId: string, month: number, year: number) {
    return and(
      eq(monthClosings.userId, userId),
      eq(monthClosings.month, month),
      eq(monthClosings.year, year),
    );
  }
  preview(userId: string, month: number, year: number, review: ClosingReview = {}) {
    return new MonthClosingChecklistService(this.db).preview(userId, month, year, review);
  }
  async getStatus(userId: string, month: number, year: number) {
    const [closing] = await this.db
      .select()
      .from(monthClosings)
      .where(this.scope(userId, month, year));
    const [pending] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isPaid, false),
          eq(transactions.isReversed, false),
          sql`CASE WHEN ${transactions.domainType}::text LIKE 'credit_card_%' AND ${transactions.billingMonth} IS NOT NULL THEN ${transactions.billingMonth}=${month} AND ${transactions.billingYear}=${year} ELSE EXTRACT(MONTH FROM ${transactions.date})=${month} AND EXTRACT(YEAR FROM ${transactions.date})=${year} END`,
        ),
      );
    const history = await this.db
      .select()
      .from(monthClosingVersions)
      .where(
        and(
          eq(monthClosingVersions.userId, userId),
          eq(monthClosingVersions.month, month),
          eq(monthClosingVersions.year, year),
        ),
      )
      .orderBy(desc(monthClosingVersions.revision));
    const obligations = await new FinancialObligationsService(this.db).listForDuePeriod(
      userId,
      month,
      year,
    );
    return {
      status: closing?.status ?? 'open',
      closedAt: closing?.closedAt ?? null,
      pendingItemsCount: pending.count,
      obligations: obligations.summary,
      revision: closing?.revision ?? 0,
      history,
      snapshot: closing
        ? {
            totalIncome: closing.totalIncome,
            totalExpenses: closing.totalExpenses,
            totalBalance: closing.totalBalance,
          }
        : null,
      breakdown: closing?.detailedBreakdown ?? null,
    };
  }
  closeMonth(
    userId: string,
    month: number,
    year: number,
    notes?: string,
    review: ClosingReview = {},
  ) {
    return runWithMaterializationLock(this.db, userId, ({ db }) =>
      new MonthClosingService(db).closeLocked(userId, month, year, notes, review),
    );
  }
  private async closeLocked(
    userId: string,
    month: number,
    year: number,
    notes: string | undefined,
    raw: ClosingReview,
  ) {
    const [existing] = await this.db
      .select()
      .from(monthClosings)
      .where(this.scope(userId, month, year))
      .for('update');
    if (existing?.status === 'closed')
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Month is already closed' });
    const review = closingReviewSchema.parse(raw);
    const preview = await this.preview(userId, month, year, review);
    if (
      preview.items.some(
        (item) =>
          item.severity === 'critical' ||
          (item.severity === 'warning' && !review.waivers[item.key]),
      )
    )
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Resolve the closing checklist and justify each noncritical exception',
      });
    if (review.reviewHash !== preview.reviewHash)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Closing evidence changed; review the checklist again',
      });
    let previousRevision = existing?.revision ?? 0;
    if (existing && previousRevision === 0) {
      previousRevision = 1;
      await this.db.insert(monthClosingVersions).values({
        userId,
        month,
        year,
        revision: previousRevision,
        action: 'reopened',
        reason: 'Preserved legacy open period; original reopening reason unavailable',
        snapshot: { legacy: true, original: existing },
      });
    }
    const revision = previousRevision + 1;
    const snapshot = {
      ...preview,
      waivers: review.waivers,
      assumptions: {
        familyReceivablesAreNotCash: true,
        estimatedIncomeIsNotCash: true,
        insuranceAndVariableSpendingNotAutomaticallyReconciled: true,
      },
    };
    const reason = notes?.trim() || 'Reviewed monthly closing';
    await this.db.insert(monthClosingVersions).values({
      userId,
      month,
      year,
      revision,
      action: 'closed',
      reason: reason.length >= 3 ? reason : 'Reviewed monthly closing',
      snapshot,
    });
    const values = {
      status: 'closed' as const,
      revision,
      totalIncome: preview.totals.income,
      totalExpenses: preview.totals.expenses,
      totalBalance: preview.totals.balance,
      detailedBreakdown: snapshot,
      closedAt: new Date(),
      notes: notes ?? null,
      updatedAt: new Date(),
    };
    const [closed] = existing
      ? await this.db
          .update(monthClosings)
          .set(values)
          .where(this.scope(userId, month, year))
          .returning()
      : await this.db
          .insert(monthClosings)
          .values({ userId, month, year, ...values })
          .returning();
    await new AuditService(this.db).log(
      userId,
      'close',
      'month_closing',
      closed.id,
      existing ?? null,
      closed,
    );
    return closed;
  }
  reopenMonth(
    userId: string,
    month: number,
    year: number,
    reason?: string,
    expectedRevision?: number,
  ) {
    return runWithMaterializationLock(this.db, userId, ({ db }) =>
      new MonthClosingService(db).reopenLocked(userId, month, year, reason, expectedRevision),
    );
  }
  private async reopenLocked(
    userId: string,
    month: number,
    year: number,
    reason: string | undefined,
    expectedRevision: number | undefined,
  ) {
    const [existing] = await this.db
      .select()
      .from(monthClosings)
      .where(this.scope(userId, month, year))
      .for('update');
    if (!existing || existing.status !== 'closed')
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Month is not closed' });
    if (!reason || reason.trim().length < 3 || reason.length > 500)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'A reopening reason is required' });
    if (expectedRevision !== undefined && expectedRevision !== existing.revision)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Closing revision changed; reload before reopening',
      });
    let previousRevision = existing.revision;
    if (previousRevision === 0) {
      previousRevision = 1;
      await this.db.insert(monthClosingVersions).values({
        userId,
        month,
        year,
        revision: previousRevision,
        action: 'closed',
        reason: 'Preserved legacy closing; original review evidence unavailable',
        snapshot: { legacy: true, original: existing },
      });
    }
    const revision = previousRevision + 1;
    await this.db.insert(monthClosingVersions).values({
      userId,
      month,
      year,
      revision,
      action: 'reopened',
      reason: reason.trim(),
      snapshot: {
        previousRevision,
        previousSnapshot: existing.detailedBreakdown,
        legacyTotals: {
          income: existing.totalIncome,
          expenses: existing.totalExpenses,
          balance: existing.totalBalance,
        },
      },
    });
    const [updated] = await this.db
      .update(monthClosings)
      .set({ status: 'open', closedAt: null, revision, updatedAt: new Date() })
      .where(this.scope(userId, month, year))
      .returning();
    await new AuditService(this.db).log(userId, 'reopen', 'month_closing', updated.id, existing, {
      ...updated,
      reason: reason.trim(),
    });
    return updated;
  }
}
