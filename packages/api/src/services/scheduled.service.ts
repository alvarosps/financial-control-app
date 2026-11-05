import type { DbExecutor } from '@fc/db';
import { accounts, scheduledTransactions, transactions } from '@fc/db';
import { BusinessRuleError, type DomainType, NotFoundError } from '@fc/domain';
import type { StatementDateSource } from '@fc/shared';
import { and, asc, count, eq } from 'drizzle-orm';

import { errorCause } from '../lib/error-codes.ts';
import { openCardPeriod } from '../lib/open-card-period.ts';
import type { PaginatedResult, PaginationInput } from '../lib/pagination.ts';
import { paginate } from '../lib/pagination.ts';
import { CreditCardLifecycleService } from './credit-card-lifecycle.service.ts';

type CreateScheduledInput = {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  description: string;
  frequency:
    | 'once'
    | 'weekly'
    | 'biweekly'
    | 'monthly'
    | 'bimonthly'
    | 'quarterly'
    | 'semiannual'
    | 'annual';
  startDate: Date;
  endDate?: Date;
  dueDay?: number;
  totalOccurrences?: number;
  startingOccurrence?: number;
  categoryId?: string;
  notes?: string;
  domainType?: DomainType;
  domainConfigId?: string;
  isFixedCharge?: boolean;
  firstBillingMonth?: number;
  firstBillingYear?: number;
  purchaseDate?: string | null;
  purchaseDateSource?: StatementDateSource;
};

type UpdateScheduledInput = {
  description?: string;
  amount?: string;
  dueDay?: number;
  endDate?: Date | null;
  notes?: string;
  categoryId?: string | null;
};

type ScheduledRow = typeof scheduledTransactions.$inferSelect;

export class ScheduledService {
  constructor(private db: DbExecutor) {}

  async create(userId: string, input: CreateScheduledInput) {
    await this.assertDestinationCardActive(userId, input.destinationAccountId);
    if (input.startingOccurrence !== undefined && input.startingOccurrence !== 1) {
      throw new BusinessRuleError(
        `startingOccurrence must be 1 (received ${input.startingOccurrence}); backdate startDate instead.`,
        errorCause('validation.startingOccurrence', {
          startingOccurrence: input.startingOccurrence,
        }),
      );
    }

    const totalOccurrences = input.frequency === 'once' ? 1 : (input.totalOccurrences ?? null);

    const [schedule] = await this.db
      .insert(scheduledTransactions)
      .values({
        userId,
        sourceAccountId: input.sourceAccountId,
        destinationAccountId: input.destinationAccountId,
        amount: input.amount,
        description: input.description,
        frequency: input.frequency,
        startDate: input.startDate,
        purchaseDate: input.purchaseDate,
        purchaseDateSource: input.purchaseDateSource,
        ...(input.endDate !== undefined && { endDate: input.endDate }),
        ...(input.dueDay !== undefined && { dueDay: input.dueDay }),
        ...(totalOccurrences !== null && { totalOccurrences }),
        ...(input.startingOccurrence !== undefined && {
          startingOccurrence: input.startingOccurrence,
        }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.domainType !== undefined && { domainType: input.domainType }),
        ...(input.domainConfigId !== undefined && { domainConfigId: input.domainConfigId }),
        ...(input.isFixedCharge !== undefined && { isFixedCharge: input.isFixedCharge }),
        ...(input.firstBillingMonth !== undefined && {
          firstBillingMonth: input.firstBillingMonth,
        }),
        ...(input.firstBillingYear !== undefined && {
          firstBillingYear: input.firstBillingYear,
        }),
      })
      .returning();

    return schedule;
  }

  async getById(userId: string, scheduleId: string) {
    const [schedule] = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(eq(scheduledTransactions.id, scheduleId), eq(scheduledTransactions.userId, userId)),
      );

    if (!schedule) {
      throw new NotFoundError('Agendamento não encontrado');
    }

    return schedule;
  }

  listByUser(userId: string): Promise<ScheduledRow[]>;
  listByUser(
    userId: string,
    page: number,
    pageSize?: number,
  ): Promise<PaginatedResult<ScheduledRow>>;
  async listByUser(userId: string, page?: number, pageSize?: number) {
    const whereCondition = and(
      eq(scheduledTransactions.userId, userId),
      eq(scheduledTransactions.isActive, true),
    );

    if (page === undefined) {
      return this.db
        .select()
        .from(scheduledTransactions)
        .where(whereCondition)
        .orderBy(asc(scheduledTransactions.createdAt), asc(scheduledTransactions.id));
    }

    const pagination: PaginationInput = { page, pageSize: pageSize ?? 50 };
    const offset = (pagination.page - 1) * pagination.pageSize;

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(scheduledTransactions)
        .where(whereCondition)
        .orderBy(asc(scheduledTransactions.createdAt), asc(scheduledTransactions.id))
        .limit(pagination.pageSize)
        .offset(offset),
      this.db.select({ total: count() }).from(scheduledTransactions).where(whereCondition),
    ]);

    return paginate(items, total, pagination);
  }

  async listByDomainType(userId: string, domainType: DomainType) {
    return this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.userId, userId),
          eq(scheduledTransactions.domainType, domainType),
          eq(scheduledTransactions.isActive, true),
        ),
      );
  }

  async update(userId: string, scheduleId: string, input: UpdateScheduledInput) {
    const schedule = await this.getById(userId, scheduleId);
    await this.assertDestinationCardActive(userId, schedule.destinationAccountId);
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(scheduledTransactions)
        .set({
          ...(input.description !== undefined && { description: input.description }),
          ...(input.amount !== undefined && { amount: input.amount }),
          ...(input.dueDay !== undefined && { dueDay: input.dueDay }),
          ...(input.endDate !== undefined && { endDate: input.endDate ?? null }),
          ...(input.notes !== undefined && { notes: input.notes }),
          ...(input.categoryId !== undefined && { categoryId: input.categoryId ?? null }),
          updatedAt: new Date(),
        })
        .where(
          and(eq(scheduledTransactions.id, scheduleId), eq(scheduledTransactions.userId, userId)),
        )
        .returning();

      if (!updated) {
        throw new NotFoundError('Agendamento não encontrado');
      }

      // Keep the fatura in sync: propagate the edited display fields to this
      // schedule's UNPAID, non-reversed materialized transactions (current +
      // future). Paid/historical rows are settled and left untouched. Without
      // this, an edit reached only the schedule (scheduled.getById) while the
      // bill — which reads materialized rows — kept showing the stale values.
      if (
        input.description !== undefined ||
        input.amount !== undefined ||
        input.categoryId !== undefined
      ) {
        await tx
          .update(transactions)
          .set({
            ...(input.description !== undefined && { description: input.description }),
            ...(input.amount !== undefined && { amount: input.amount }),
            ...(input.categoryId !== undefined && { categoryId: input.categoryId ?? null }),
          })
          .where(
            and(
              eq(transactions.scheduledTransactionId, scheduleId),
              eq(transactions.userId, userId),
              eq(transactions.isPaid, false),
              eq(transactions.isReversed, false),
              openCardPeriod(),
            ),
          );
      }

      return updated;
    });
  }

  async deactivate(userId: string, scheduleId: string) {
    const schedule = await this.getById(userId, scheduleId);
    await this.assertDestinationCardActive(userId, schedule.destinationAccountId);
    const [updated] = await this.db
      .update(scheduledTransactions)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(eq(scheduledTransactions.id, scheduleId), eq(scheduledTransactions.userId, userId)),
      )
      .returning();

    if (!updated) {
      throw new NotFoundError('Agendamento não encontrado');
    }

    return updated;
  }

  /**
   * "Delete" a scheduled item (e.g. a credit-card installment) from current and
   * future bills: deactivate the schedule AND remove its unpaid, non-reversed
   * materialized transactions. Paid (historical) rows are preserved. Atomic, and
   * works whether the schedule is currently active or already inactive — unlike
   * plain `deactivate`, which left the materialized rows behind (so the item kept
   * showing in the bill) and could strand a schedule whose rows then made the UI
   * call transaction.reverse with a schedule id (NOT_FOUND → 500).
   */
  async deleteSchedule(userId: string, scheduleId: string) {
    return this.db.transaction(async (tx) => {
      const [schedule] = await tx
        .select()
        .from(scheduledTransactions)
        .where(
          and(eq(scheduledTransactions.id, scheduleId), eq(scheduledTransactions.userId, userId)),
        );

      if (!schedule) {
        throw new NotFoundError('Agendamento não encontrado');
      }

      await new ScheduledService(tx).assertDestinationCardActive(
        userId,
        schedule.destinationAccountId,
      );

      const deleted = await tx
        .delete(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, scheduleId),
            eq(transactions.userId, userId),
            eq(transactions.isPaid, false),
            eq(transactions.isReversed, false),
            openCardPeriod(),
          ),
        )
        .returning({ id: transactions.id });

      await tx
        .update(scheduledTransactions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(eq(scheduledTransactions.id, scheduleId), eq(scheduledTransactions.userId, userId)),
        );

      return { id: scheduleId, deletedCount: deleted.length };
    });
  }

  private async assertDestinationCardActive(userId: string, destinationAccountId: string) {
    const [destination] = await this.db
      .select({ type: accounts.type })
      .from(accounts)
      .where(eq(accounts.id, destinationAccountId));
    if (destination?.type === 'credit_card') {
      await new CreditCardLifecycleService(this.db).assertActiveCard(userId, destinationAccountId);
    }
  }
}
