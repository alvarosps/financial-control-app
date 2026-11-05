import type { DbExecutor } from '@fc/db';
import {
  accounts,
  borrowedCards,
  familyLoanConfigs,
  materializationStatus,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import type { DomainType } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';

import type { MaterializationGuardLike } from '../lib/materialization-guard.ts';
import { openCardPeriod } from '../lib/open-card-period.ts';
import { AccountService } from './account.service.ts';
import { FamilyLoanLedgerService } from './family-loan-ledger.service.ts';
import { FamilyLoanPaymentService } from './family-loan-payment.service.ts';
import { loadFamilyLoanConfig } from './family-loan-shared.ts';
import { MaterializerService } from './materializer.service.ts';
import { ScheduledService } from './scheduled.service.ts';

export class FamilyLoanFlowService {
  private accountService: AccountService;
  private scheduledService: ScheduledService;
  private ledgerService: FamilyLoanLedgerService;
  private paymentService: FamilyLoanPaymentService;

  constructor(
    private db: DbExecutor,
    _guard?: MaterializationGuardLike,
  ) {
    this.accountService = new AccountService(db);
    this.scheduledService = new ScheduledService(db);
    this.ledgerService = new FamilyLoanLedgerService(db);
    this.paymentService = new FamilyLoanPaymentService(db);
  }

  async createFamilyLoan(
    userId: string,
    input: {
      personName: string;
      currency?: string;
      notes?: string;
      receiptDay?: number;
    },
  ) {
    const account = await this.accountService.create(userId, {
      name: input.personName,
      type: 'family_loan',
      currency: input.currency ?? 'BRL',
    });

    const [config] = await this.db
      .insert(familyLoanConfigs)
      .values({
        accountId: account.id,
        personName: input.personName,
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.receiptDay !== undefined && { receiptDay: input.receiptDay }),
      })
      .returning();

    return { account, config };
  }

  async list(userId: string) {
    const configs = await this.db
      .select()
      .from(familyLoanConfigs)
      .innerJoin(accounts, eq(accounts.id, familyLoanConfigs.accountId))
      .where(and(eq(accounts.userId, userId), eq(accounts.isActive, true)));

    return configs.map((row) => ({
      ...row.family_loan_configs,
      config: row.family_loan_configs,
      account: row.accounts,
    }));
  }

  async getById(userId: string, configId: string) {
    const config = await loadFamilyLoanConfig(this.db, userId, configId);

    const [account] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, config.accountId));

    const cards = await this.db
      .select()
      .from(borrowedCards)
      .where(eq(borrowedCards.familyLoanConfigId, config.id));

    return { config, account, borrowedCards: cards };
  }

  async update(
    userId: string,
    configId: string,
    input: {
      personName?: string;
      notes?: string | null;
      receiptDay?: number;
    },
  ) {
    const config = await loadFamilyLoanConfig(this.db, userId, configId);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.personName !== undefined) updates.personName = input.personName;
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.receiptDay !== undefined) updates.receiptDay = input.receiptDay;

    const [updated] = await this.db
      .update(familyLoanConfigs)
      .set(updates)
      .where(
        and(
          eq(familyLoanConfigs.id, config.id),
          sql`EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.id} = ${familyLoanConfigs.accountId} AND ${accounts.userId} = ${userId})`,
        ),
      )
      .returning();

    if (input.personName !== undefined) {
      await this.db
        .update(accounts)
        .set({ name: input.personName, updatedAt: new Date() })
        .where(and(eq(accounts.id, config.accountId), eq(accounts.userId, userId)));
    }

    return updated;
  }

  async deactivate(userId: string, configId: string) {
    const config = await loadFamilyLoanConfig(this.db, userId, configId);

    await this.accountService.deactivate(userId, config.accountId);

    // Deactivate all related schedules
    const schedules = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.domainConfigId, config.id),
          eq(scheduledTransactions.isActive, true),
        ),
      );

    for (const s of schedules) {
      await this.scheduledService.deactivate(userId, s.id);
    }

    return { success: true };
  }

  async listItems(userId: string, configId: string, domainType: DomainType) {
    const config = await loadFamilyLoanConfig(this.db, userId, configId);

    const items = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.domainConfigId, config.id),
          eq(scheduledTransactions.domainType, domainType),
          eq(scheduledTransactions.isActive, true),
        ),
      );

    return items;
  }

  async listWithTotals(userId: string, month: number, year: number) {
    const configs = await this.list(userId);

    const results = await Promise.all(
      configs.map(async (config) => {
        // `monthly` must continue to come from getMonthlyTotal: the family-loans page
        // renders monthly.installments, monthly.discounts, and monthly.borrowedCardBreakdown,
        // which owedByMonthRange (aggregated by month) does not provide. getLedger already
        // batches via owedByMonthRange; this only parallelizes the two reads per config.
        const [monthly, ledger] = await Promise.all([
          this.getMonthlyTotal(userId, config.id, month, year),
          this.getLedger(userId, config.id, { currentPeriod: { month, year } }),
        ]);
        return {
          ...config,
          monthly,
          monthlyTotal: monthly.total,
          outstanding: ledger.totals.totalOutstanding,
          overdue: ledger.totals.totalOverdue,
        };
      }),
    );

    return results;
  }

  async addBorrowedCard(
    userId: string,
    input: {
      configId: string;
      creditCardAccountId: string;
      description?: string;
    },
  ) {
    const config = await loadFamilyLoanConfig(this.db, userId, input.configId);
    await this.accountService.getById(userId, input.creditCardAccountId);

    const [borrowedCard] = await this.db
      .insert(borrowedCards)
      .values({
        familyLoanConfigId: config.id,
        creditCardAccountId: input.creditCardAccountId,
        ...(input.description !== undefined && { description: input.description }),
      })
      .returning();

    return borrowedCard;
  }

  async addInstallment(
    userId: string,
    input: {
      configId: string;
      description: string;
      amount: string;
      totalInstallments: number;
      currentInstallment: number;
      dueDay: number;
      billingMonth?: number;
      billingYear?: number;
      categoryId?: string;
    },
  ) {
    const config = await loadFamilyLoanConfig(this.db, userId, input.configId);

    // Compute startDate from billing period and current installment
    const now = new Date();
    const billingMonth = input.billingMonth ?? now.getMonth() + 1;
    const billingYear = input.billingYear ?? now.getFullYear();

    // startDate = first day of (billingMonth - currentInstallment + 1)
    const startMonth = billingMonth - input.currentInstallment + 1;
    const startDate = new Date(billingYear, startMonth - 1, 1);

    return this.db.transaction(async (tx) => {
      const txScheduledService = new ScheduledService(tx);
      const txMaterializerService = new MaterializerService(tx);

      const schedule = await txScheduledService.create(userId, {
        sourceAccountId: config.accountId,
        destinationAccountId: config.accountId,
        amount: input.amount,
        description: input.description,
        frequency: 'monthly',
        startDate,
        dueDay: input.dueDay,
        totalOccurrences: input.totalInstallments,
        startingOccurrence: 1,
        domainType: 'family_loan_installment',
        domainConfigId: config.id,
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      });

      const materialized = await txMaterializerService.materialize(userId, 12);

      return { schedule, materialized };
    });
  }

  async editInstallment(
    userId: string,
    input: {
      scheduleId: string;
      description: string;
      amount: string;
      totalInstallments: number;
      currentInstallment: number;
      currentBillingMonth: number;
      currentBillingYear: number;
      categoryId?: string | null;
    },
  ) {
    if (input.currentInstallment > input.totalInstallments) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Current installment cannot be greater than total installments',
      });
    }

    // Scope to the schedule's owning config so a foreign scheduleId is rejected
    // and we have the config.accountId (source = destination for installments).
    const [schedule] = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.id, input.scheduleId),
          eq(scheduledTransactions.userId, userId),
          eq(scheduledTransactions.domainType, 'family_loan_installment'),
        ),
      );
    if (!schedule?.domainConfigId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Family loan installment not found' });
    }
    const config = await loadFamilyLoanConfig(this.db, userId, schedule.domainConfigId);

    // Recompute startDate the same way addInstallment does: the schedule always
    // carries startingOccurrence=1, so the series anchor (parcela 1) is the
    // month (currentBillingMonth - currentInstallment + 1).
    const startMonth = input.currentBillingMonth - input.currentInstallment + 1;
    const startDate = new Date(input.currentBillingYear, startMonth - 1, 1);
    return this.db.transaction(async (tx) => {
      await tx
        .update(scheduledTransactions)
        .set({
          description: input.description,
          amount: input.amount,
          frequency: 'monthly',
          startDate,
          totalOccurrences: input.totalInstallments,
          startingOccurrence: 1,
          isActive: true,
          categoryId: input.categoryId ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(scheduledTransactions.id, input.scheduleId),
            eq(scheduledTransactions.userId, userId),
          ),
        );

      // Purge the unpaid, non-reversed materialized rows so they regenerate with
      // the new amount/parcela/total. Paid and closed history stays untouched.
      await tx
        .delete(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, input.scheduleId),
            eq(transactions.userId, userId),
            eq(transactions.isReversed, false),
            eq(transactions.isPaid, false),
            openCardPeriod(),
          ),
        );

      await tx.delete(materializationStatus).where(eq(materializationStatus.userId, userId));
      const txMaterializerService = new MaterializerService(tx);
      const materialized = await txMaterializerService.materialize(userId, 12);

      return {
        scheduleId: input.scheduleId,
        configId: config.id,
        materialized,
      };
    });
  }

  async editAdjustment(
    userId: string,
    input: {
      scheduleId: string;
      description: string;
      amount: string;
      date: Date;
      totalInstallments?: number;
      currentInstallment?: number;
      dueDay?: number;
    },
  ) {
    const installmentFields = [input.totalInstallments, input.currentInstallment, input.dueDay];
    const presentFields = installmentFields.filter((field) => field != null).length;
    if (presentFields !== 0 && presentFields !== installmentFields.length) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Installment fields must be provided together',
      });
    }

    const isInstallment = presentFields === installmentFields.length;
    if (
      isInstallment &&
      ((input.totalInstallments ?? 0) < 2 ||
        (input.currentInstallment ?? 0) > (input.totalInstallments ?? 0))
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Invalid installment values',
      });
    }
    const dateYear = input.date.getUTCFullYear();
    if (dateYear < 2020 || dateYear > 2100) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Date must be between 2020 and 2100',
      });
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`);

      const [schedule] = await tx
        .select()
        .from(scheduledTransactions)
        .where(
          and(
            eq(scheduledTransactions.id, input.scheduleId),
            eq(scheduledTransactions.userId, userId),
          ),
        );
      if (
        !schedule?.domainConfigId ||
        (schedule.domainType !== 'family_loan_expense' &&
          schedule.domainType !== 'family_loan_discount')
      ) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Family loan adjustment not found' });
      }
      if (schedule.domainType === 'family_loan_expense' && isInstallment) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Family loan expenses cannot be installment schedules',
        });
      }

      const config = await loadFamilyLoanConfig(tx, userId, schedule.domainConfigId);
      const occurrences = await tx
        .select({
          id: transactions.id,
          installmentNumber: transactions.installmentNumber,
          isPaid: transactions.isPaid,
          isReversed: transactions.isReversed,
          open: openCardPeriod().mapWith(Boolean),
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, input.scheduleId),
            eq(transactions.userId, userId),
          ),
        );
      const settledOccurrences = occurrences.filter(
        (occurrence) => occurrence.isPaid || occurrence.isReversed || !occurrence.open,
      );
      if (schedule.frequency === 'once' && settledOccurrences.length > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Settled one-time adjustments cannot be edited',
        });
      }
      if (!isInstallment && settledOccurrences.length > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'An installment adjustment with settled history cannot become one-time',
        });
      }
      const highestSettledInstallment = settledOccurrences.reduce(
        (highest, occurrence) => Math.max(highest, occurrence.installmentNumber ?? 0),
        0,
      );
      if (
        isInstallment &&
        input.totalInstallments != null &&
        input.totalInstallments < highestSettledInstallment
      ) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Total installments cannot exclude settled history',
        });
      }

      const startDate = isInstallment
        ? new Date(
            Date.UTC(
              input.date.getUTCFullYear(),
              input.date.getUTCMonth() - ((input.currentInstallment ?? 1) - 1),
              1,
            ),
          )
        : input.date;

      await tx
        .update(scheduledTransactions)
        .set({
          description: input.description,
          amount: input.amount,
          frequency: isInstallment ? 'monthly' : 'once',
          startDate,
          dueDay: isInstallment ? (input.dueDay ?? null) : null,
          totalOccurrences: isInstallment ? (input.totalInstallments ?? null) : null,
          startingOccurrence: 1,
          endDate: null,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(scheduledTransactions.id, input.scheduleId),
            eq(scheduledTransactions.userId, userId),
          ),
        );

      await tx
        .delete(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, input.scheduleId),
            eq(transactions.userId, userId),
            eq(transactions.isPaid, false),
            eq(transactions.isReversed, false),
            openCardPeriod(),
          ),
        );
      await tx.delete(materializationStatus).where(eq(materializationStatus.userId, userId));
      const materialized = await new MaterializerService(tx).materialize(userId, 12);

      return {
        scheduleId: input.scheduleId,
        configId: config.id,
        materialized,
      };
    });
  }

  async addFixedCharge(
    userId: string,
    input: {
      configId: string;
      description: string;
      amount: string;
      startDate: Date;
      dueDay: number;
      categoryId?: string;
    },
  ) {
    const config = await loadFamilyLoanConfig(this.db, userId, input.configId);

    return this.db.transaction(async (tx) => {
      const txScheduledService = new ScheduledService(tx);
      const txMaterializerService = new MaterializerService(tx);

      const schedule = await txScheduledService.create(userId, {
        sourceAccountId: config.accountId,
        destinationAccountId: config.accountId,
        amount: input.amount,
        description: input.description,
        frequency: 'monthly',
        startDate: input.startDate,
        dueDay: input.dueDay,
        domainType: 'family_loan_fixed_charge',
        domainConfigId: config.id,
        isFixedCharge: true,
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      });

      const materialized = await txMaterializerService.materialize(userId, 12);

      return { schedule, materialized };
    });
  }

  async addOneTimeCharge(
    userId: string,
    input: {
      configId: string;
      description: string;
      amount: string;
      date: Date;
      billingMonth?: number;
      billingYear?: number;
      categoryId?: string;
    },
  ) {
    const config = await loadFamilyLoanConfig(this.db, userId, input.configId);

    return this.db.transaction(async (tx) => {
      const txScheduledService = new ScheduledService(tx);
      const txMaterializerService = new MaterializerService(tx);

      const schedule = await txScheduledService.create(userId, {
        sourceAccountId: config.accountId,
        destinationAccountId: config.accountId,
        amount: input.amount,
        description: input.description,
        frequency: 'once',
        startDate: input.date,
        domainType: 'family_loan_expense',
        domainConfigId: config.id,
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      });

      const materialized = await txMaterializerService.materialize(userId, 12);

      return { schedule, materialized };
    });
  }

  async addDiscount(
    userId: string,
    input: {
      configId: string;
      description: string;
      amount: string;
      date: Date;
      totalInstallments?: number;
      currentInstallment?: number;
      dueDay?: number;
      categoryId?: string;
    },
  ) {
    const config = await loadFamilyLoanConfig(this.db, userId, input.configId);

    const isInstallment = input.totalInstallments != null && input.totalInstallments > 1;
    const currentInstallment = input.currentInstallment ?? 1;

    if (
      isInstallment &&
      input.totalInstallments != null &&
      currentInstallment > input.totalInstallments
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Current installment cannot be greater than total installments',
      });
    }

    const startDate = isInstallment
      ? new Date(input.date.getFullYear(), input.date.getMonth() - (currentInstallment - 1), 1)
      : input.date;

    return this.db.transaction(async (tx) => {
      const txScheduledService = new ScheduledService(tx);
      const txMaterializerService = new MaterializerService(tx);

      const schedule = await txScheduledService.create(userId, {
        sourceAccountId: config.accountId,
        destinationAccountId: config.accountId,
        amount: input.amount,
        description: input.description,
        frequency: isInstallment ? 'monthly' : 'once',
        startDate,
        domainType: 'family_loan_discount',
        domainConfigId: config.id,
        ...(isInstallment && input.totalInstallments != null
          ? { totalOccurrences: input.totalInstallments, startingOccurrence: 1 }
          : {}),
        ...(input.dueDay != null && { dueDay: input.dueDay }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      });

      const materialized = await txMaterializerService.materialize(userId, 12);

      return { schedule, materialized };
    });
  }

  firstOwedMonth(userId: string, configId: string) {
    return this.ledgerService.firstOwedMonth(userId, configId);
  }

  owedByMonthRange(
    userId: string,
    configId: string,
    from: { month: number; year: number },
    to: { month: number; year: number },
  ) {
    return this.ledgerService.owedByMonthRange(userId, configId, from, to);
  }

  getMonthlyTotal(userId: string, configId: string, month: number, year: number) {
    return this.ledgerService.getMonthlyTotal(userId, configId, month, year);
  }

  get12MonthProjection(userId: string, configId: string, month: number, year: number) {
    return this.ledgerService.get12MonthProjection(userId, configId, { month, year });
  }
  recordPayment(
    userId: string,
    input: {
      configId: string;
      amount: string;
      date: Date;
      walletAccountId: string;
      notes?: string;
    },
  ) {
    return this.paymentService.recordPayment(userId, input);
  }

  listPayments(userId: string, configId: string) {
    return this.paymentService.listPayments(userId, configId);
  }

  reversePayment(userId: string, transactionId: string) {
    return this.paymentService.reversePayment(userId, transactionId);
  }

  getLedger(
    userId: string,
    configId: string,
    opts?: {
      asOf?: Date;
      currentPeriod?: { month: number; year: number };
      forwardMonths?: number;
    },
  ) {
    return this.ledgerService.getLedger(userId, configId, opts);
  }
}
