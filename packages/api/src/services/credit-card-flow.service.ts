import type { DbExecutor } from '@fc/db';
import { accounts, creditCardConfigs, scheduledTransactions, transactions } from '@fc/db';
import { type DomainType, normalizeInstallment } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';
import { acquireBillLocks } from '../lib/bill-lock.ts';
import { createCardWriteContext } from '../lib/card-write-context.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import {
  type StatementTransactionDates,
  statementTransactionDates,
} from '../lib/statement-dates.ts';
import { AccountService } from './account.service.ts';
import { CreditCardLifecycleService } from './credit-card-lifecycle.service.ts';
import { FinancialEventService } from './financial-event.service.ts';
import {
  type MaterializationBatch,
  MaterializationCoordinator,
  type ScheduleChangeCheckpoint,
} from './materialization-coordinator.service.ts';
import { ScheduledService } from './scheduled.service.ts';
import { TransactionService } from './transaction.service.ts';

export class CreditCardFlowService {
  private accountService: AccountService;
  private cardLifecycle: CreditCardLifecycleService;

  constructor(
    private db: DbExecutor,
    private options: { capturePurchases?: boolean } = {},
  ) {
    this.accountService = new AccountService(db);
    this.cardLifecycle = new CreditCardLifecycleService(db);
  }

  async createCreditCard(
    userId: string,
    input: {
      name: string;
      closingDay: number;
      dueDay: number;
      creditLimit?: string;
      currency?: string;
      icon?: string;
      color?: string;
      billParserType?: string;
      isDueDayVariable?: boolean;
      parentAccountId?: string;
    },
  ) {
    if (input.parentAccountId !== undefined) {
      await this.cardLifecycle.assertActiveCard(userId, input.parentAccountId);
    }
    const account = await this.accountService.create(userId, {
      name: input.name,
      type: 'credit_card',
      currency: input.currency ?? 'BRL',
      ...(input.icon !== undefined && { icon: input.icon }),
      ...(input.color !== undefined && { color: input.color }),
      ...(input.parentAccountId !== undefined && { parentAccountId: input.parentAccountId }),
    });

    const [config] = await this.db
      .insert(creditCardConfigs)
      .values({
        accountId: account.id,
        closingDay: input.closingDay,
        dueDay: input.dueDay,
        ...(input.creditLimit !== undefined && { creditLimit: input.creditLimit }),
        ...(input.billParserType !== undefined && { billParserType: input.billParserType }),
        ...(input.isDueDayVariable !== undefined && { isDueDayVariable: input.isDueDayVariable }),
      })
      .returning();

    return { account, config };
  }

  async addInstallment(
    userId: string,
    input: {
      creditCardAccountId: string;
      expenseAccountId: string;
      description: string;
      amount: string;
      totalInstallments: number;
      currentInstallmentNumber: number;
      currentBillingMonth: number;
      currentBillingYear: number;
      categoryId?: string;
      purchaseDate?: string | Date | null;
      purchaseDateSource?: 'institution' | 'user';
    },
    materializationBatch?: MaterializationBatch,
  ) {
    await this.cardLifecycle.assertActiveCard(userId, input.creditCardAccountId);
    await this.accountService.getById(userId, input.creditCardAccountId);
    await this.accountService.getById(userId, input.expenseAccountId);

    const cfg = await this.getConfig(userId, input.creditCardAccountId);
    if (!cfg) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Config do cartão não encontrada. Configure closingDay/dueDay primeiro.',
      });
    }

    const { firstBillingMonth, firstBillingYear } = normalizeInstallment({
      currentInstallmentNumber: input.currentInstallmentNumber,
      totalInstallments: input.totalInstallments,
      currentBillingMonth: input.currentBillingMonth,
      currentBillingYear: input.currentBillingYear,
    });

    // startDate is cosmetic after normalization (billing assignment is by index
    // — see materializer D2). Use the due-day of the first bill month so the
    // calendar view shows the installment on the due date.
    const startDate = new Date(firstBillingYear, firstBillingMonth - 1, cfg.dueDay);

    // Horizon must cover the full series: pick max(12, totalInstallments) so
    // we never leave tail occurrences unmaterialized.
    const horizon = Math.max(12, input.totalInstallments);
    const purchase = statementTransactionDates(input);

    return this.db.transaction(async (tx) => {
      const coordinator = new MaterializationCoordinator(tx);
      const checkpoint = materializationBatch ? null : await coordinator.captureCheckpoint(userId);
      const txScheduledService = new ScheduledService(tx);

      const schedule = await txScheduledService.create(userId, {
        sourceAccountId: input.expenseAccountId,
        destinationAccountId: input.creditCardAccountId,
        amount: input.amount,
        description: input.description,
        frequency: 'monthly',
        startDate,
        dueDay: cfg.dueDay,
        totalOccurrences: input.totalInstallments,
        startingOccurrence: 1,
        purchaseDate: purchase.purchaseDate,
        purchaseDateSource: purchase.purchaseDateSource,
        firstBillingMonth,
        firstBillingYear,
        domainType: 'credit_card_installment' satisfies DomainType,
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      });

      const result = materializationBatch
        ? materializationBatch.deferFill(schedule.id, horizon)
        : await coordinator.finalizeScheduleChanges({
            checkpoint: requireCheckpoint(checkpoint),
            fillScheduleIds: [schedule.id],
            rebuildScheduleIds: [],
            minimumHorizonMonths: horizon,
          });

      const period = { month: input.currentBillingMonth, year: input.currentBillingYear };
      if (materializationBatch) materializationBatch.settleInstallmentsBefore(schedule.id, period);
      else await coordinator.settleInstallmentsBefore(userId, schedule.id, period);

      if (this.options.capturePurchases !== false)
        await new FinancialEventService(tx).recordManual(
          userId,
          {
            cardAccountId: input.creditCardAccountId,
            description: input.description,
            amount: input.amount,
            currency: schedule.currency,
            amountMeaning: 'installment',
            kind: 'purchase',
            purchaseDate: purchase.purchaseDate,
            postedDate: null,
            installmentNumber: input.currentInstallmentNumber,
            totalInstallments: input.totalInstallments,
            confirmation: 'observed',
          },
          { scheduleId: schedule.id },
        );

      return { schedule, materialized: result, firstBillingMonth, firstBillingYear };
    });
  }

  /**
   * Edit an existing installment series the way addInstallment creates one:
   * recompute firstBilling from (current installment, total, current billing
   * period), normalise the schedule (starting_occurrence=1, index-based billing),
   * then re-materialize so the new amount/total/numbering apply across the series.
   *
   * Re-materializing drops only UNPAID, non-reversed rows and recreates them.
   * PAID occurrences are settled history and are preserved verbatim (id, amount,
   * paidAt, paidFromAccountId), including a paid row whose installmentNumber
   * exceeds a reduced totalInstallments. Amount changes therefore affect only
   * open occurrences. Plain `scheduled.update` neither re-numbered nor
   * re-materialized, so edits never reached the bill.
   */
  async editInstallment(
    userId: string,
    input: {
      scheduleId: string;
      description: string;
      amount: string;
      totalInstallments: number;
      currentInstallmentNumber: number;
      currentBillingMonth: number;
      currentBillingYear: number;
      categoryId?: string | null;
    },
    materializationBatch?: MaterializationBatch,
  ) {
    if (input.currentInstallmentNumber > input.totalInstallments) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Current installment cannot be greater than total installments',
      });
    }

    const [schedule] = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.id, input.scheduleId),
          eq(scheduledTransactions.userId, userId),
        ),
      );
    if (!schedule) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Agendamento não encontrado' });
    }

    await this.cardLifecycle.assertActiveCard(userId, schedule.destinationAccountId);
    const cfg = await this.getConfig(userId, schedule.destinationAccountId);
    if (!cfg) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Config do cartão não encontrada. Configure closingDay/dueDay primeiro.',
      });
    }

    const { firstBillingMonth, firstBillingYear } = normalizeInstallment({
      currentInstallmentNumber: input.currentInstallmentNumber,
      totalInstallments: input.totalInstallments,
      currentBillingMonth: input.currentBillingMonth,
      currentBillingYear: input.currentBillingYear,
    });
    const startDate = new Date(firstBillingYear, firstBillingMonth - 1, cfg.dueDay);
    const horizon = Math.max(12, input.totalInstallments);

    return this.db.transaction(async (tx) => {
      const coordinator = new MaterializationCoordinator(tx);
      const checkpoint = materializationBatch ? null : await coordinator.captureCheckpoint(userId);
      await tx
        .update(scheduledTransactions)
        .set({
          description: input.description,
          amount: input.amount,
          frequency: 'monthly',
          startDate,
          dueDay: cfg.dueDay,
          totalOccurrences: input.totalInstallments,
          startingOccurrence: 1,
          firstBillingMonth,
          firstBillingYear,
          domainType: 'credit_card_installment' satisfies DomainType,
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

      const result = materializationBatch
        ? materializationBatch.deferRebuild(input.scheduleId, horizon)
        : await coordinator.finalizeScheduleChanges({
            checkpoint: requireCheckpoint(checkpoint),
            fillScheduleIds: [],
            rebuildScheduleIds: [input.scheduleId],
            minimumHorizonMonths: horizon,
          });

      const period = { month: input.currentBillingMonth, year: input.currentBillingYear };
      if (materializationBatch)
        materializationBatch.settleInstallmentsBefore(input.scheduleId, period);
      else await coordinator.settleInstallmentsBefore(userId, input.scheduleId, period);

      return {
        scheduleId: input.scheduleId,
        materialized: result,
        firstBillingMonth,
        firstBillingYear,
      };
    });
  }

  async getConfig(userId: string, accountId: string) {
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, accountId));

    if (!account || account.userId !== userId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Conta não encontrada' });
    }

    const [config] = await this.db
      .select()
      .from(creditCardConfigs)
      .where(eq(creditCardConfigs.accountId, accountId));

    return config ?? null;
  }

  async listConfigs(userId: string) {
    const cardAccounts = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
          eq(accounts.isActive, true),
        ),
      );

    const configs = await this.db
      .select()
      .from(creditCardConfigs)
      .where(
        cardAccounts.length > 0
          ? sql`${creditCardConfigs.accountId} IN (${sql.join(
              cardAccounts.map((a) => sql`${a.id}`),
              sql`, `,
            )})`
          : sql`false`,
      );

    return configs;
  }

  async upsertConfig(
    userId: string,
    input: {
      accountId: string;
      closingDay: number;
      dueDay: number;
      creditLimit?: string;
      billParserType?: string;
      isDueDayVariable?: boolean;
    },
  ) {
    await this.cardLifecycle.assertActiveCard(userId, input.accountId);
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, input.accountId));

    if (!account || account.userId !== userId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Conta não encontrada' });
    }

    if (account.type !== 'credit_card') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'Configuração de cartão de crédito só pode ser definida para contas do tipo cartão de crédito',
      });
    }

    const [existing] = await this.db
      .select()
      .from(creditCardConfigs)
      .where(eq(creditCardConfigs.accountId, input.accountId));

    if (existing) {
      // creditCardConfigs has no direct userId column; tenancy is enforced by
      // joining to accounts so a forged input.accountId cannot update another
      // user's config even in the face of TOCTOU between the ownership check
      // above and the UPDATE.
      const [updated] = await this.db
        .update(creditCardConfigs)
        .set({
          closingDay: input.closingDay,
          dueDay: input.dueDay,
          ...(input.creditLimit !== undefined && { creditLimit: input.creditLimit }),
          ...(input.billParserType !== undefined && { billParserType: input.billParserType }),
          ...(input.isDueDayVariable !== undefined && {
            isDueDayVariable: input.isDueDayVariable,
          }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(creditCardConfigs.accountId, input.accountId),
            sql`EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.id} = ${creditCardConfigs.accountId} AND ${accounts.userId} = ${userId})`,
          ),
        )
        .returning();

      return updated;
    }

    const [created] = await this.db
      .insert(creditCardConfigs)
      .values({
        accountId: input.accountId,
        closingDay: input.closingDay,
        dueDay: input.dueDay,
        ...(input.creditLimit !== undefined && { creditLimit: input.creditLimit }),
        ...(input.billParserType !== undefined && { billParserType: input.billParserType }),
        ...(input.isDueDayVariable !== undefined && { isDueDayVariable: input.isDueDayVariable }),
      })
      .returning();

    return created;
  }

  /**
   * Guard against writing into a settled fatura. A fatura is considered "paid"
   * when it already has charge rows and none of them are still unpaid. The
   * `bill_payment` row (the payment of the bill itself) is excluded so it does
   * not mask an otherwise-empty fatura.
   */
  private async assertFaturaNotPaid(
    userId: string,
    cardId: string,
    billingMonth: number,
    billingYear: number,
  ) {
    const [row] = await this.db
      .select({
        unpaid: sql<number>`count(*) FILTER (WHERE ${transactions.isPaid} = false)`,
        total: sql<number>`count(*)`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.destinationAccountId, cardId),
          eq(transactions.billingMonth, billingMonth),
          eq(transactions.billingYear, billingYear),
          eq(transactions.isReversed, false),
          sql`${transactions.domainType} NOT IN ('bill_payment', 'credit_card_refund')`,
        ),
      );

    if (Number(row?.total ?? 0) > 0 && Number(row?.unpaid ?? 0) === 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Fatura já está paga; escolha uma fatura em aberto.',
      });
    }
  }

  async addOneTimeExpense(
    userId: string,
    input: {
      creditCardAccountId: string;
      expenseAccountId: string;
      description: string;
      amount: string;
      billingMonth: number;
      billingYear: number;
      categoryId?: string;
    } & StatementTransactionDates,
  ) {
    const dates = statementTransactionDates(input);
    const knownDate = dates.postedDate ?? dates.purchaseDate;
    return this.addOneTimeCardTransaction(userId, {
      creditCardAccountId: input.creditCardAccountId,
      expenseAccountId: input.expenseAccountId,
      description: input.description,
      amount: input.amount,
      billingMonth: input.billingMonth,
      billingYear: input.billingYear,
      date: knownDate
        ? new Date(`${knownDate}T00:00:00Z`)
        : new Date(Date.UTC(input.billingYear, input.billingMonth - 1, 1)),
      ...dates,
      domainType: 'credit_card_expense',
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
    });
  }

  async addRefund(
    userId: string,
    input: {
      creditCardAccountId: string;
      expenseAccountId: string;
      description: string;
      amount: string;
      billingMonth: number;
      billingYear: number;
      refundDate?: Date;
    } & StatementTransactionDates,
  ) {
    const dates = statementTransactionDates({
      ...input,
      postedDate: input.postedDate ?? input.refundDate,
    });
    const knownDate = dates.postedDate ?? dates.purchaseDate;
    return this.addOneTimeCardTransaction(userId, {
      creditCardAccountId: input.creditCardAccountId,
      expenseAccountId: input.expenseAccountId,
      description: input.description,
      amount: input.amount,
      billingMonth: input.billingMonth,
      billingYear: input.billingYear,
      date: knownDate
        ? new Date(`${knownDate}T00:00:00Z`)
        : new Date(Date.UTC(input.billingYear, input.billingMonth - 1, 1)),
      ...dates,
      domainType: 'credit_card_refund',
    });
  }

  private async addOneTimeCardTransaction(
    userId: string,
    input: {
      creditCardAccountId: string;
      expenseAccountId: string;
      description: string;
      amount: string;
      billingMonth: number;
      billingYear: number;
      date: Date;
      domainType: 'credit_card_expense' | 'credit_card_refund';
      categoryId?: string;
    } & ReturnType<typeof statementTransactionDates>,
  ) {
    await this.cardLifecycle.assertActiveCard(userId, input.creditCardAccountId);
    await this.accountService.getById(userId, input.creditCardAccountId);
    await this.accountService.getById(userId, input.expenseAccountId);
    await this.assertFaturaNotPaid(
      userId,
      input.creditCardAccountId,
      input.billingMonth,
      input.billingYear,
    );

    return this.db.transaction(async (tx) =>
      runWithMaterializationLock(tx, userId, async ({ db }) => {
        await acquireBillLocks(db, userId, [
          {
            cardAccountId: input.creditCardAccountId,
            month: input.billingMonth,
            year: input.billingYear,
          },
        ]);
        const txFlow = new CreditCardFlowService(db);
        await txFlow.assertFaturaNotPaid(
          userId,
          input.creditCardAccountId,
          input.billingMonth,
          input.billingYear,
        );
        const transaction = await new TransactionService(db).createWithinCardFlow(
          createCardWriteContext(userId),
          userId,
          {
            sourceAccountId: input.expenseAccountId,
            destinationAccountId: input.creditCardAccountId,
            amount: input.amount,
            description: input.description,
            date: input.date,
            purchaseDate: input.purchaseDate,
            postedDate: input.postedDate,
            purchaseDateSource: input.purchaseDateSource,
            postedDateSource: input.postedDateSource,
            billingMonth: input.billingMonth,
            billingYear: input.billingYear,
            domainType: input.domainType satisfies DomainType,
            ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
          },
        );

        if (this.options.capturePurchases !== false)
          await new FinancialEventService(db).recordManual(
            userId,
            {
              cardAccountId: input.creditCardAccountId,
              description: input.description,
              amount: input.amount,
              currency: transaction.currency,
              amountMeaning: 'purchase_total',
              kind: input.domainType === 'credit_card_refund' ? 'refund' : 'purchase',
              purchaseDate: input.purchaseDate,
              postedDate: input.postedDate,
              installmentNumber: null,
              totalInstallments: null,
              confirmation: 'observed',
            },
            { transactionId: transaction.id },
          );
        return { transaction };
      }),
    );
  }

  async addFixedCharge(
    userId: string,
    input: {
      creditCardAccountId: string;
      expenseAccountId: string;
      description: string;
      amount: string;
      startDate: Date;
      dueDay: number;
      categoryId?: string;
      firstBillingMonth?: number;
      firstBillingYear?: number;
    },
    materializationBatch?: MaterializationBatch,
  ) {
    await this.cardLifecycle.assertActiveCard(userId, input.creditCardAccountId);
    await this.accountService.getById(userId, input.creditCardAccountId);
    await this.accountService.getById(userId, input.expenseAccountId);

    if (input.firstBillingMonth !== undefined && input.firstBillingYear !== undefined) {
      await this.assertFaturaNotPaid(
        userId,
        input.creditCardAccountId,
        input.firstBillingMonth,
        input.firstBillingYear,
      );
    }

    return this.db.transaction(async (tx) => {
      const coordinator = new MaterializationCoordinator(tx);
      const checkpoint = materializationBatch ? null : await coordinator.captureCheckpoint(userId);
      const txScheduledService = new ScheduledService(tx);

      const schedule = await txScheduledService.create(userId, {
        sourceAccountId: input.expenseAccountId,
        destinationAccountId: input.creditCardAccountId,
        amount: input.amount,
        description: input.description,
        frequency: 'monthly',
        startDate: input.startDate,
        dueDay: input.dueDay,
        domainType: 'credit_card_fixed_charge' satisfies DomainType,
        isFixedCharge: true,
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.firstBillingMonth !== undefined &&
          input.firstBillingYear !== undefined && {
            firstBillingMonth: input.firstBillingMonth,
            firstBillingYear: input.firstBillingYear,
          }),
      });

      const result = materializationBatch
        ? materializationBatch.deferFill(schedule.id, 12)
        : await coordinator.finalizeScheduleChanges({
            checkpoint: requireCheckpoint(checkpoint),
            fillScheduleIds: [schedule.id],
            rebuildScheduleIds: [],
            minimumHorizonMonths: 12,
          });

      return { schedule, materialized: result };
    });
  }
}

function requireCheckpoint(checkpoint: ScheduleChangeCheckpoint | null): ScheduleChangeCheckpoint {
  if (checkpoint === null) throw new Error('Missing materialization checkpoint');
  return checkpoint;
}
