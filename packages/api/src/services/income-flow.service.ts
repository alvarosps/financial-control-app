import type { DbExecutor } from '@fc/db';
import {
  accounts,
  incomeSourceConfigs,
  materializationStatus,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import { type DomainType, getDomainTypesByGroup } from '@fc/domain';
import type { Frequency } from '@fc/shared';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { cashInWindow } from '../lib/cash-selection.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import {
  assertNoPayrollAllocation,
  assertOpenSettlementPeriods,
  settlementDateKey,
} from '../lib/settlement-guards.ts';
import { AccountService } from './account.service.ts';
import { MaterializerService } from './materializer.service.ts';
import { ScheduledService } from './scheduled.service.ts';

function incomeCategoryToDomainType(category: string): DomainType {
  const map: Record<string, DomainType> = {
    salary_clt: 'income_clt',
    salary_pj: 'income_pj',
    contractor: 'income_pj',
    rental: 'income_rental',
    freelance: 'income_freelancer',
    investment: 'income_other',
    business: 'income_other',
    other: 'income_other',
  };
  return map[category] ?? 'income_other';
}

/** Map income frequency enum ('one_time') to scheduled transaction frequency enum ('once') */
function toScheduledFrequency(
  freq: 'monthly' | 'biweekly' | 'weekly' | 'annual' | 'once' | 'one_time',
): 'once' | 'weekly' | 'biweekly' | 'monthly' | 'annual' {
  if (freq === 'one_time') return 'once';
  return freq as 'once' | 'weekly' | 'biweekly' | 'monthly' | 'annual';
}

/** Format a Date as a `YYYY-MM-DD` string from its UTC parts (date columns are mode:'date' strings). */
function toDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

const INCOME_DOMAIN_TYPES = new Set(getDomainTypesByGroup('income'));

export class IncomeFlowService {
  private accountService: AccountService;
  private scheduledService: ScheduledService;
  private materializerService: MaterializerService;

  constructor(private db: DbExecutor) {
    this.accountService = new AccountService(db);
    this.scheduledService = new ScheduledService(db);
    this.materializerService = new MaterializerService(db);
  }

  async createIncomeSource(
    userId: string,
    input: {
      description: string;
      amount: string;
      frequency: 'monthly' | 'biweekly' | 'weekly' | 'annual' | 'once' | 'one_time';
      category:
        | 'salary_clt'
        | 'salary_pj'
        | 'contractor'
        | 'rental'
        | 'investment'
        | 'freelance'
        | 'business'
        | 'other';
      destinationAccountId: string;
      startDate: Date;
      paymentDay?: number;
      exchangeRate?: string;
      currency?: string;
      autoCreditByDate?: boolean;
      biweeklyAnchor?: string;
    },
  ) {
    await this.accountService.getById(userId, input.destinationAccountId);

    const account = await this.accountService.create(userId, {
      name: input.description,
      type: 'revenue',
      currency: input.currency ?? 'BRL',
    });

    // DB uses general 'frequency' enum with 'once' (not 'income_frequency' with 'one_time')
    const dbFreq: Frequency = input.frequency === 'one_time' ? 'once' : input.frequency;
    // Biweekly cadence needs a phase anchor: use the explicit one when given,
    // otherwise derive it from the chosen startDate. Non-biweekly leaves it unset.
    const biweeklyAnchor =
      input.frequency === 'biweekly'
        ? (input.biweeklyAnchor ?? toDateString(input.startDate))
        : undefined;
    const [config] = await this.db
      .insert(incomeSourceConfigs)
      .values({
        accountId: account.id,
        autoCreditByDate: input.autoCreditByDate ?? false,
        frequency: dbFreq,
        category: input.category,
        ...(input.paymentDay !== undefined && { paymentDay: input.paymentDay }),
        ...(input.exchangeRate !== undefined && { exchangeRate: input.exchangeRate }),
        ...(biweeklyAnchor !== undefined && { biweeklyAnchor }),
      })
      .returning();

    const scheduledFreq = toScheduledFrequency(input.frequency);
    const schedule = await this.scheduledService.create(userId, {
      sourceAccountId: account.id,
      destinationAccountId: input.destinationAccountId,
      amount: input.amount,
      description: input.description,
      frequency: scheduledFreq,
      startDate: input.startDate,
      ...(input.paymentDay !== undefined && { dueDay: input.paymentDay }),
      domainType: incomeCategoryToDomainType(input.category),
      domainConfigId: config.id,
    });

    await this.db.delete(materializationStatus).where(eq(materializationStatus.userId, userId));
    const materialized = await this.materializerService.materializeForUserLocked(userId, 12);

    return { account, config, schedule, materialized };
  }

  async update(
    userId: string,
    input: {
      accountId: string;
      description?: string;
      amount?: string;
      frequency?: 'monthly' | 'biweekly' | 'weekly' | 'annual' | 'once' | 'one_time';
      category?:
        | 'salary_clt'
        | 'salary_pj'
        | 'contractor'
        | 'rental'
        | 'investment'
        | 'freelance'
        | 'business'
        | 'other';
      paymentDay?: number | null;
      exchangeRate?: string | null;
      currency?: string;
      autoCreditByDate?: boolean;
      startDate?: Date;
      biweeklyAnchor?: string;
    },
  ) {
    await this.accountService.getById(userId, input.accountId);

    if (input.description !== undefined) {
      await this.db
        .update(accounts)
        .set({ name: input.description, updatedAt: new Date() })
        .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, userId)));
    }

    if (input.currency !== undefined) {
      await this.db
        .update(accounts)
        .set({ currency: input.currency, updatedAt: new Date() })
        .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, userId)));
    }

    const configUpdates: Record<string, unknown> = {};
    if (input.autoCreditByDate !== undefined)
      configUpdates.autoCreditByDate = input.autoCreditByDate;
    if (input.frequency !== undefined) {
      configUpdates.frequency = input.frequency === 'one_time' ? 'once' : input.frequency;
    }
    if (input.category !== undefined) configUpdates.category = input.category;
    if (input.paymentDay !== undefined) configUpdates.paymentDay = input.paymentDay;
    if (input.exchangeRate !== undefined) configUpdates.exchangeRate = input.exchangeRate;
    // Biweekly anchor: honour an explicit value, otherwise derive it from the
    // updated startDate when the source is (being) switched to biweekly.
    if (input.biweeklyAnchor !== undefined) {
      configUpdates.biweeklyAnchor = input.biweeklyAnchor;
    } else if (input.frequency === 'biweekly' && input.startDate !== undefined) {
      configUpdates.biweeklyAnchor = toDateString(input.startDate);
    }
    if (Object.keys(configUpdates).length > 0) {
      configUpdates.updatedAt = new Date();
      // incomeSourceConfigs has no userId; tenancy is enforced via accounts.
      await this.db
        .update(incomeSourceConfigs)
        .set(configUpdates)
        .where(
          and(
            eq(incomeSourceConfigs.accountId, input.accountId),
            sql`EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.id} = ${incomeSourceConfigs.accountId} AND ${accounts.userId} = ${userId})`,
          ),
        );
    }

    const scheduleUpdates: Record<string, unknown> = {};
    if (input.amount !== undefined) scheduleUpdates.amount = input.amount;
    if (input.frequency !== undefined)
      scheduleUpdates.frequency = toScheduledFrequency(input.frequency);
    if (input.paymentDay !== undefined) scheduleUpdates.dueDay = input.paymentDay;
    if (input.currency !== undefined) scheduleUpdates.currency = input.currency;
    if (input.startDate !== undefined) scheduleUpdates.startDate = input.startDate;
    if (input.category !== undefined) {
      scheduleUpdates.domainType = incomeCategoryToDomainType(input.category);
    }
    if (Object.keys(scheduleUpdates).length > 0) {
      scheduleUpdates.updatedAt = new Date();
      await this.db
        .update(scheduledTransactions)
        .set(scheduleUpdates)
        .where(
          and(
            eq(scheduledTransactions.sourceAccountId, input.accountId),
            eq(scheduledTransactions.userId, userId),
            eq(scheduledTransactions.isActive, true),
          ),
        );
    }

    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, input.accountId));

    return { success: true, account };
  }

  async list(userId: string) {
    const revenueAccounts = await this.db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.userId, userId), eq(accounts.type, 'revenue'), eq(accounts.isActive, true)),
      );

    return Promise.all(
      revenueAccounts.map(async (account) => {
        const [config] = await this.db
          .select()
          .from(incomeSourceConfigs)
          .where(eq(incomeSourceConfigs.accountId, account.id));

        const schedules = await this.db
          .select()
          .from(scheduledTransactions)
          .where(
            and(
              or(
                config ? eq(scheduledTransactions.domainConfigId, config.id) : sql`false`,
                eq(scheduledTransactions.sourceAccountId, account.id),
              ),
              inArray(scheduledTransactions.domainType, getDomainTypesByGroup('income')),
              eq(scheduledTransactions.isActive, true),
            ),
          );

        return { account, config: config ?? null, schedule: schedules[0] ?? null };
      }),
    );
  }

  async getById(userId: string, accountId: string) {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));

    if (!account) {
      return null;
    }

    const [config] = await this.db
      .select()
      .from(incomeSourceConfigs)
      .where(eq(incomeSourceConfigs.accountId, accountId));

    return { account, config: config ?? null };
  }

  /**
   * Edita o valor BRL realizado de uma ocorrência de renda JÁ recebida.
   * Movido do income.router (delegate fino) — mesmas guardas e retorno.
   */
  async editReceivedAmount(
    userId: string,
    input: { transactionId: string; amountBrl: string },
  ): Promise<{ success: true; affectsCurrentBalance: boolean }> {
    return runWithMaterializationLock(this.db, userId, ({ db }) =>
      new IncomeFlowService(db).editReceivedAmountInternal(userId, input),
    );
  }

  private async editReceivedAmountInternal(
    userId: string,
    input: { transactionId: string; amountBrl: string },
  ): Promise<{ success: true; affectsCurrentBalance: boolean }> {
    const [tx] = await this.db
      .select({
        domainType: transactions.domainType,
        isPaid: transactions.isPaid,
        isReversed: transactions.isReversed,
        destinationAccountId: transactions.destinationAccountId,
        paidAt: transactions.paidAt,
        date: transactions.date,
        settlementDate: transactions.settlementDate,
      })
      .from(transactions)
      .where(and(eq(transactions.id, input.transactionId), eq(transactions.userId, userId)));
    if (!tx) throw new TRPCError({ code: 'NOT_FOUND', message: 'Transaction not found' });
    await assertNoPayrollAllocation(this.db, userId, input.transactionId);
    await assertOpenSettlementPeriods(this.db, userId, [
      tx.date.toISOString().slice(0, 10),
      ...(tx.settlementDate ? [settlementDateKey(tx.settlementDate)] : []),
    ]);
    if (tx.domainType == null || !INCOME_DOMAIN_TYPES.has(tx.domainType))
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Transaction is not an income occurrence',
      });
    if (tx.isReversed)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Transaction has been reversed' });
    if (!tx.isPaid)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Only received occurrences can be edited',
      });
    await this.db
      .update(transactions)
      .set({ cashAmount: input.amountBrl, settlementSource: 'manual', updatedAt: new Date() })
      .where(and(eq(transactions.id, input.transactionId), eq(transactions.userId, userId)));

    // The wallet's displayed cash is anchored: WalletCashService bakes
    // movements at/before `openingBalanceAnchorAt` into the opening balance,
    // so editing a PAID row that settled before the anchor updates reports but
    // NOT the anchored current balance. Tell the UI so it can inform the user.
    const [acct] = tx.destinationAccountId
      ? await this.db
          .select({
            type: accounts.type,
            currency: accounts.currency,
            isActive: accounts.isActive,
            openingBalanceAnchorAt: accounts.openingBalanceAnchorAt,
            cashAnchorBasis: accounts.cashAnchorBasis,
          })
          .from(accounts)
          .where(and(eq(accounts.id, tx.destinationAccountId), eq(accounts.userId, userId)))
      : [];
    const [scope] = acct
      ? await this.db
          .select({
            eligible: cashInWindow(
              acct.openingBalanceAnchorAt ?? new Date(0),
              acct.cashAnchorBasis,
              new Date(),
            ),
          })
          .from(transactions)
          .where(and(eq(transactions.id, input.transactionId), eq(transactions.userId, userId)))
      : [];
    const affectsCurrentBalance =
      acct?.type === 'checking' &&
      acct.currency === 'BRL' &&
      acct.isActive &&
      scope?.eligible === true;

    return { success: true, affectsCurrentBalance };
  }

  async deactivate(userId: string, accountId: string) {
    await this.accountService.deactivate(userId, accountId);

    const schedules = await this.scheduledService.listByUser(userId);
    for (const s of schedules) {
      if (s.sourceAccountId === accountId) {
        await this.scheduledService.deactivate(userId, s.id);
      }
    }

    return { success: true };
  }
}
