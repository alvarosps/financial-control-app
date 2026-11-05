import type { DbExecutor } from '@fc/db';
import { accounts, scheduledTransactions, transactions } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, eq, gte, lte } from 'drizzle-orm';

import { AccountService } from './account.service.ts';
import { CategoryService } from './category.service.ts';
import { MaterializerService } from './materializer.service.ts';
import { ScheduledService } from './scheduled.service.ts';
import { SettlementService } from './settlement.service.ts';

type TransactionRow = typeof transactions.$inferSelect;
type ScheduleRow = typeof scheduledTransactions.$inferSelect;

/**
 * A charge schedule plus the paid-state of its occurrence in the VIEWED month.
 * `transactionId` is the id of the materialized `recurring_bill` transaction for
 * that month (so the client can route `charges.markOccurrenceAsPaid`), or null
 * when the occurrence is not materialized — or when `list` was called without a
 * month/year (no occurrence context).
 */
export type ChargeRow = ScheduleRow & {
  transactionId: string | null;
  isPaid: boolean;
};

const CHARGE_EXPENSE_ACCOUNT_NAME = 'Cobranças';

function alignStartToDueDay(startDate: Date, dueDay: number): Date {
  const year = startDate.getFullYear();
  const month = startDate.getMonth();
  const lastDayThisMonth = new Date(year, month + 1, 0).getDate();
  const dayThisMonth = Math.min(dueDay, lastDayThisMonth);
  if (dayThisMonth >= startDate.getDate()) {
    return new Date(year, month, dayThisMonth);
  }
  const lastDayNextMonth = new Date(year, month + 2, 0).getDate();
  return new Date(year, month + 1, Math.min(dueDay, lastDayNextMonth));
}

export class ChargeFlowService {
  private accountService: AccountService;
  private categoryService: CategoryService;
  private scheduledService: ScheduledService;
  private materializerService: MaterializerService;
  private settlement: SettlementService;

  constructor(private db: DbExecutor) {
    this.accountService = new AccountService(db);
    this.categoryService = new CategoryService(db);
    this.scheduledService = new ScheduledService(db);
    this.materializerService = new MaterializerService(db);
    this.settlement = new SettlementService(db);
  }

  /** Single shared 'expense' destination account for all charges; created on demand. */
  private async getOrCreateChargesExpenseAccount(userId: string): Promise<string> {
    const [existing] = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'expense'),
          eq(accounts.name, CHARGE_EXPENSE_ACCOUNT_NAME),
          eq(accounts.isActive, true),
        ),
      );
    if (existing) return existing.id;
    const created = await this.accountService.create(userId, {
      name: CHARGE_EXPENSE_ACCOUNT_NAME,
      type: 'expense',
      currency: 'BRL',
    });
    return created.id;
  }

  async createFixed(
    userId: string,
    input: {
      description: string;
      amount: string;
      sourceAccountId: string;
      startDate: Date;
      dueDay: number;
      endDate?: Date;
      categoryId?: string;
    },
  ) {
    await this.accountService.getById(userId, input.sourceAccountId);
    if (input.categoryId !== undefined) {
      await this.categoryService.getById(userId, input.categoryId);
    }
    const expenseAccountId = await this.getOrCreateChargesExpenseAccount(userId);

    const schedule = await this.scheduledService.create(userId, {
      sourceAccountId: input.sourceAccountId,
      destinationAccountId: expenseAccountId,
      amount: input.amount,
      description: input.description,
      frequency: 'monthly',
      startDate: alignStartToDueDay(input.startDate, input.dueDay),
      dueDay: input.dueDay,
      domainType: 'recurring_bill',
      isFixedCharge: true,
      ...(input.endDate !== undefined && { endDate: input.endDate }),
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
    });

    const materialized = await this.materializerService.rematerializeForSchedule(
      userId,
      schedule.id,
      12,
    );
    return { schedule, materialized };
  }

  async createOneTime(
    userId: string,
    input: {
      description: string;
      amount: string;
      sourceAccountId: string;
      date: Date;
      dueDay?: number;
      categoryId?: string;
      isPaid?: boolean;
    },
  ) {
    const sourceAccount = await this.accountService.getById(userId, input.sourceAccountId);
    if (input.categoryId !== undefined) {
      await this.categoryService.getById(userId, input.categoryId);
    }
    // A paid one-time charge stamps paidFromAccountId = sourceAccountId, so that
    // account must be a real wallet (checking/savings) — mirrors
    // SettlementService.settle. Reject non-wallet sources before creating the
    // schedule so a crafted sourceAccountId cannot mark an expense/card as the
    // paying wallet.
    if (
      input.isPaid === true &&
      sourceAccount.type !== 'checking' &&
      sourceAccount.type !== 'savings'
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Paid one-time charge must be paid from a checking or savings account',
      });
    }
    const expenseAccountId = await this.getOrCreateChargesExpenseAccount(userId);

    const schedule = await this.scheduledService.create(userId, {
      sourceAccountId: input.sourceAccountId,
      destinationAccountId: expenseAccountId,
      amount: input.amount,
      description: input.description,
      frequency: 'once',
      startDate: input.date,
      // ScheduledService.create forces totalOccurrences=1 for frequency:'once', so the
      // materializer stamps the single occurrence as installmentNumber=1/totalInstallments=1.
      // Intentional and harmless — same as one-time income; charge aggregation (upcoming/daily)
      // reads recurring_bill SCHEDULES, never these materialized installment fields.
      totalOccurrences: 1,
      domainType: 'recurring_bill',
      ...(input.dueDay !== undefined && { dueDay: input.dueDay }),
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
    });

    const materialized = await this.materializerService.rematerializeForSchedule(
      userId,
      schedule.id,
      12,
    );

    if (input.isPaid === true) {
      const occurrences = await this.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.isReversed, false),
            eq(transactions.isPaid, false),
          ),
        );
      for (const occurrence of occurrences) {
        await this.settlement.settle(userId, {
          transactionId: occurrence.id,
          walletAccountId: input.sourceAccountId,
          leg: 'source',
        });
      }
    }

    return { schedule, materialized };
  }

  async update(
    userId: string,
    input: {
      scheduleId: string;
      description?: string;
      amount?: string;
      dueDay?: number;
      endDate?: Date | null;
      categoryId?: string | null;
    },
  ) {
    // Validate category ownership on edit too (null = clear, allowed through).
    if (input.categoryId != null) {
      await this.categoryService.getById(userId, input.categoryId);
    }
    // Only forward fields ScheduledService.update accepts (no startDate).
    const { scheduleId, ...fields } = input;
    await this.scheduledService.update(userId, scheduleId, fields);
    const materialized = await this.materializerService.rematerializeForSchedule(
      userId,
      scheduleId,
      12,
    );
    return { success: true, materialized };
  }

  async deactivate(userId: string, scheduleId: string) {
    await this.scheduledService.deleteSchedule(userId, scheduleId);
    return { success: true };
  }

  async getById(userId: string, scheduleId: string) {
    return this.scheduledService.getById(userId, scheduleId);
  }

  /**
   * Fixed = active recurring_bill with frequency != 'once'. One-time = frequency
   * 'once' whose startDate is in (month, year).
   *
   * Each returned row carries `transactionId` + `isPaid` for the VIEWED month's
   * materialized occurrence (so the Cobranças page can offer "marcar como pago").
   * When `month`/`year` are omitted there is no occurrence context, so every row
   * gets `transactionId: null, isPaid: false`.
   */
  async list(userId: string, month?: number, year?: number) {
    const hasMonthContext = month !== undefined && year !== undefined;
    const now = new Date();
    const m = month ?? now.getMonth() + 1;
    const y = year ?? now.getFullYear();
    const startDate = new Date(Date.UTC(y, m - 1, 1));
    const endDate = new Date(Date.UTC(y, m, 0));

    const all = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.userId, userId),
          eq(scheduledTransactions.domainType, 'recurring_bill'),
        ),
      );

    const fixedSchedules = all.filter((s) => s.frequency !== 'once');
    const oneTimeSchedules = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.userId, userId),
          eq(scheduledTransactions.domainType, 'recurring_bill'),

          eq(scheduledTransactions.frequency, 'once'),
          gte(scheduledTransactions.startDate, startDate),
          lte(scheduledTransactions.startDate, endDate),
        ),
      );

    // One query for ALL relevant materialized occurrences in the viewed month,
    // mapped by scheduledTransactionId (avoids N+1). Skipped entirely when there
    // is no month context. Both fixed and one-time occurrences land in the same
    // [monthStart, monthEnd] window: a fixed charge's monthly occurrence is dated
    // on its dueDay within the month, and a one-time charge's single occurrence is
    // dated on its startDate (already month-filtered above). Scoped to userId
    // alongside runtime RLS.
    const occurrenceBySchedule = new Map<
      string,
      { id: string | null; isPaid: boolean; amount: string }
    >();
    if (hasMonthContext) {
      const occurrences = await this.db
        .select({
          id: transactions.id,
          isPaid: transactions.isPaid,
          settlementSource: transactions.settlementSource,
          amount: transactions.amount,
          scheduledTransactionId: transactions.scheduledTransactionId,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.domainType, 'recurring_bill'),
            eq(transactions.isReversed, false),
            gte(transactions.date, startDate),
            lte(transactions.date, endDate),
          ),
        );
      for (const occ of occurrences) {
        if (occ.scheduledTransactionId === null) continue;
        // Duplicate occurrences require review, never an arbitrary payable row.
        if (!occurrenceBySchedule.has(occ.scheduledTransactionId)) {
          occurrenceBySchedule.set(occ.scheduledTransactionId, {
            id: occ.id,
            isPaid: occ.isPaid && occ.settlementSource !== 'date_assumed',
            amount: occ.amount,
          });
        } else {
          occurrenceBySchedule.set(occ.scheduledTransactionId, {
            id: null,
            isPaid: false,
            amount: occ.amount,
          });
        }
      }
    }

    const withOccurrence = (s: ScheduleRow): ChargeRow => {
      const occ = occurrenceBySchedule.get(s.id);
      return {
        ...s,
        amount: occ?.amount ?? s.amount,
        transactionId: occ?.id ?? null,
        isPaid: occ?.isPaid ?? false,
      };
    };

    return {
      fixed: fixedSchedules
        .filter(
          (s) =>
            occurrenceBySchedule.has(s.id) ||
            (s.isActive &&
              (!hasMonthContext ||
                (s.startDate <= endDate && (!s.endDate || s.endDate >= startDate)))),
        )
        .map(withOccurrence),
      oneTime: oneTimeSchedules
        .filter((s) => s.isActive || occurrenceBySchedule.has(s.id))
        .map(withOccurrence),
      month: m,
      year: y,
    };
  }

  /**
   * Load a user-owned transaction and assert it is a settleable CHARGE row.
   * Mirrors `assertSettleableIncomeTx` (income.router) so a crafted
   * `transactionId` cannot redirect an expense/loan/reversed row — or another
   * user's row — through the charge settlement path. `requireUnpaid` enforces
   * the precondition for the verb (paid vs. unpaid).
   *
   * INTENTIONALLY a SERVICE-level method (the income equivalent lives in its
   * router). Keeping the guard here means service tests — and any future caller
   * besides the router — get the same enforcement; do NOT "harmonize" it back
   * into the router, which would drop service-level protection.
   */
  private async assertSettleableChargeTx(
    userId: string,
    transactionId: string,
    requireUnpaid: boolean,
  ) {
    const [tx] = await this.db
      .select({
        id: transactions.id,
        domainType: transactions.domainType,
        isPaid: transactions.isPaid,
        isReversed: transactions.isReversed,
      })
      .from(transactions)
      .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)));
    // Missing OR foreign: the userId-scoped load returns no row for another
    // user's transaction, so NOT_FOUND is indistinguishable from truly
    // non-existent (and leaks nothing). Matches assertSettleableIncomeTx.
    if (!tx) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Transaction not found' });
    }
    if (tx.domainType !== 'recurring_bill') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Transaction is not a charge occurrence',
      });
    }
    if (tx.isReversed) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Transaction has been reversed' });
    }
    if (requireUnpaid && tx.isPaid) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Occurrence is already paid' });
    }
    if (!requireUnpaid && !tx.isPaid) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Occurrence is not paid' });
    }
  }

  /**
   * Mark a materialized charge occurrence paid and redirect its wallet (source)
   * leg to `paidFromAccountId` (Option A — parity with loans/income). The guard
   * is scoped to `userId`, so another user's row cannot be settled.
   */
  async markOccurrenceAsPaid(
    userId: string,
    transactionId: string,
    paidFromAccountId: string,
    settlementDate?: Date,
    expectedRevision?: string,
  ): Promise<TransactionRow> {
    await this.assertSettleableChargeTx(userId, transactionId, true);
    return this.settlement.settle(userId, {
      transactionId,
      walletAccountId: paidFromAccountId,
      leg: 'source',
      settlementDate,
      expectedRevision,
    });
  }

  /** Undo a charge payment: clears paid flags and restores the schedule's source leg. */
  async markOccurrenceAsUnpaid(userId: string, transactionId: string): Promise<TransactionRow> {
    await this.assertSettleableChargeTx(userId, transactionId, false);
    return this.settlement.unsettle(userId, transactionId);
  }
}
