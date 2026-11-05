import type { DbExecutor } from '@fc/db';
import { accounts, loanConfigs, payrollDeductions, transactions } from '@fc/db';
import type { PayoffCalculationType } from '@fc/domain';
import {
  calculateOutstandingBalance,
  calculatePayoffSavings,
  Money,
  selectPayoffQuote,
} from '@fc/domain';
import type { LoanPaymentMethod } from '@fc/shared';
import { TRPCError } from '@trpc/server';
import Decimal from 'decimal.js';
import { and, eq, inArray, isNull, lt, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { loanCostEvidenceSchema } from '../lib/loan-cost-input.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { settlementDateKey } from '../lib/settlement-guards.ts';

import { AccountService } from './account.service.ts';
import { AuditService } from './audit.service.ts';
import { CashReadinessService } from './cash-readiness.service.ts';
import { computeCurrentInstallment } from './loan-installment.ts';
import { MaterializerService } from './materializer.service.ts';
import { ScheduledService } from './scheduled.service.ts';
import { SettlementService } from './settlement.service.ts';

/** Months since year 0 — lets us diff two dates by whole months. */
const monthOrdinal = (d: Date) => d.getFullYear() * 12 + d.getMonth();

/** YYYY-MM-DD from a date column (UTC-day, matching how date columns deserialize). */
const toIsoDate = (value: Date | string): string => {
  if (typeof value === 'string') return value.slice(0, 10);
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export class LoanFlowService {
  private accountService: AccountService;
  private materializerService: MaterializerService;

  constructor(private db: DbExecutor) {
    this.accountService = new AccountService(db);
    this.materializerService = new MaterializerService(db);
  }

  async createLoan(
    userId: string,
    input: {
      name: string;
      loanCategory: 'bank' | 'personal';
      loanType: 'consignado' | 'pessoal' | 'veiculo' | 'imobiliario';
      monthlyPayment: string;
      totalInstallments: number;
      /**
       * Optional override of how far along the loan is. When omitted, it is
       * derived from the first-installment date vs. today. An explicit value
       * takes priority and may be 0 or negative (loan hasn't started yet).
       */
      currentInstallment?: number;
      dueDay: number;
      /** Date of the FIRST installment (occurrence 1). */
      startDate: Date;
      checkingAccountId: string;
      monthlyInterestRate: string;
      annualInterestRate?: string;
      insuranceAmount?: string;
      insurancePaymentDay?: number;
      payoffCalculationType?:
        | 'consignado_mensal'
        | 'pessoal_diario'
        | 'cdc_veiculos'
        | 'sem_desconto';
      principalAmount?: string;
      originalAmount?: string;
      comment?: string;
      currency?: string;
      paymentMethod?: LoanPaymentMethod;
      incomeSourceAccountId?: string | null;
    },
  ) {
    if (
      input.currentInstallment !== undefined &&
      input.currentInstallment > input.totalInstallments
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Current installment cannot be greater than total installments',
      });
    }

    await this.accountService.getById(userId, input.checkingAccountId);
    await this.validateIncomeSource(
      userId,
      input.paymentMethod ?? null,
      input.incomeSourceAccountId ?? null,
    );

    return this.db.transaction(async (tx) => {
      const txAccountService = new AccountService(tx);
      const txScheduledService = new ScheduledService(tx);
      const txMaterializerService = new MaterializerService(tx);

      const account = await txAccountService.create(userId, {
        name: input.name,
        type: 'loan',
        currency: input.currency ?? 'BRL',
      });

      const [config] = await tx
        .insert(loanConfigs)
        .values({
          accountId: account.id,
          loanCategory: input.loanCategory,
          totalInstallments: input.totalInstallments,
          monthlyPayment: input.monthlyPayment,
          dueDay: input.dueDay,
          loanType: input.loanType,
          paymentMethod: input.paymentMethod,
          incomeSourceAccountId: input.incomeSourceAccountId,
          monthlyInterestRate: input.monthlyInterestRate,
          ...(input.annualInterestRate !== undefined && {
            annualInterestRate: input.annualInterestRate,
          }),
          ...(input.insuranceAmount !== undefined && { insuranceAmount: input.insuranceAmount }),
          ...(input.insurancePaymentDay !== undefined && {
            insurancePaymentDay: input.insurancePaymentDay,
          }),
          ...(input.payoffCalculationType !== undefined && {
            payoffCalculationType: input.payoffCalculationType,
          }),
          ...(input.principalAmount !== undefined && { principalAmount: input.principalAmount }),
          ...(input.originalAmount !== undefined && { originalAmount: input.originalAmount }),
          ...(input.startDate !== undefined && { startDate: input.startDate }),
          ...(input.comment !== undefined && { comment: input.comment }),
        })
        .returning();

      // `input.startDate` is the first installment date (occurrence 1). No
      // backdating: occurrence 1 lands exactly on that month. How far along the
      // loan is gets derived below, or comes from an explicit override.
      const schedule = await txScheduledService.create(userId, {
        sourceAccountId: input.checkingAccountId,
        destinationAccountId: account.id,
        amount: input.monthlyPayment,
        description: `${input.name} - Parcela`,
        frequency: 'monthly',
        startDate: input.startDate,
        dueDay: input.dueDay,
        totalOccurrences: input.totalInstallments,
        startingOccurrence: 1,
        domainType: 'loan_payment',
        domainConfigId: config.id,
      });

      let insuranceSchedule = null;
      if (input.insuranceAmount && input.insurancePaymentDay) {
        insuranceSchedule = await txScheduledService.create(userId, {
          sourceAccountId: input.checkingAccountId,
          destinationAccountId: account.id,
          amount: input.insuranceAmount,
          description: `${input.name} - Seguro`,
          frequency: 'monthly',
          startDate: input.startDate,
          dueDay: input.insurancePaymentDay,
          domainType: 'loan_insurance',
          domainConfigId: config.id,
        });
      }

      const monthsUntilFirst = Math.max(
        0,
        monthOrdinal(input.startDate) - monthOrdinal(new Date()),
      );
      const horizon = Math.max(12, input.totalInstallments + monthsUntilFirst);
      const materialized = await txMaterializerService.materialize(userId, horizon);

      const effectiveCurrent =
        input.currentInstallment ?? (await computeCurrentInstallment(tx, account.id));

      if (effectiveCurrent > 1 && input.paymentMethod !== 'payroll') {
        await tx
          .update(transactions)
          .set({ isPaid: true, paidAt: new Date() })
          .where(
            and(
              eq(transactions.scheduledTransactionId, schedule.id),
              eq(transactions.userId, userId),
              lt(transactions.installmentNumber, effectiveCurrent),
            ),
          );
      }

      return { account, config, schedule, insuranceSchedule, materialized };
    });
  }

  private async validateIncomeSource(
    userId: string,
    method: LoanPaymentMethod | null,
    sourceId: string | null,
  ) {
    if (!sourceId) return;
    const source = await this.accountService.getById(userId, sourceId);
    if (method !== 'payroll' || source.type !== 'revenue' || !source.isActive)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Select an active income source for payroll',
      });
  }

  async setPaymentMethod(
    userId: string,
    accountId: string,
    method: LoanPaymentMethod | null,
    sourceId: string | null,
  ) {
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const account = await new AccountService(db).getById(userId, accountId);
      if (account.type !== 'loan')
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select a loan account' });
      await new LoanFlowService(db).validateIncomeSource(userId, method, sourceId);
      const [config] = await db
        .select()
        .from(loanConfigs)
        .where(eq(loanConfigs.accountId, accountId))
        .for('update');
      if (!config)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Loan configuration not found' });
      if (config.paymentMethod === method && config.incomeSourceAccountId === sourceId)
        return config;
      const [active] = await db
        .select({ id: payrollDeductions.id })
        .from(payrollDeductions)
        .innerJoin(transactions, eq(transactions.id, payrollDeductions.loanTransactionId))
        .where(
          and(
            eq(payrollDeductions.userId, userId),
            eq(transactions.userId, userId),
            eq(transactions.destinationAccountId, accountId),
            isNull(payrollDeductions.reversedAt),
          ),
        );
      if (active)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Undo payroll before changing its loan binding',
        });
      const [updated] = await db
        .update(loanConfigs)
        .set({ paymentMethod: method, incomeSourceAccountId: sourceId })
        .where(eq(loanConfigs.id, config.id))
        .returning();
      return updated;
    });
  }

  async markCurrentAsPaid(userId: string, loanAccountId: string, paidFromAccountId?: string) {
    await this.accountService.getById(userId, loanAccountId);

    const unpaid = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.destinationAccountId, loanAccountId),
          eq(transactions.domainType, 'loan_payment'),
          eq(transactions.isPaid, false),
          eq(transactions.isReversed, false),
        ),
      );

    if (unpaid.length === 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No unpaid installments found for this loan',
      });
    }

    unpaid.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const target = unpaid[0];

    if (!paidFromAccountId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A wallet is required to pay a loan installment',
      });
    }
    const updated = await new SettlementService(this.db).settle(userId, {
      transactionId: target.id,
      walletAccountId: paidFromAccountId,
      leg: 'source',
    });

    return { transaction: updated, remaining: unpaid.length - 1 };
  }

  async markOccurrenceAsPaid(
    userId: string,
    input: {
      accountId: string;
      transactionId: string;
      paidFromAccountId: string;
      settlementDate: Date;
      expectedRevision?: string;
    },
  ) {
    const account = await this.accountService.getById(userId, input.accountId);
    const [row] = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.id, input.transactionId),
          eq(transactions.userId, userId),
          eq(transactions.destinationAccountId, input.accountId),
          inArray(transactions.domainType, ['loan_payment', 'loan_insurance']),
        ),
      );
    if (account.type !== 'loan' || !row)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Loan installment not found' });
    return new SettlementService(this.db).settle(userId, {
      transactionId: row.id,
      walletAccountId: input.paidFromAccountId,
      leg: 'source',
      settlementDate: input.settlementDate,
      expectedRevision: input.expectedRevision,
    });
  }

  /** The oldest unpaid installment for this loan, for the confirm dialog. */
  async getNextPayable(userId: string, loanAccountId: string) {
    await this.accountService.getById(userId, loanAccountId);
    const unpaid = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.destinationAccountId, loanAccountId),
          eq(transactions.domainType, 'loan_payment'),
          eq(transactions.isPaid, false),
          eq(transactions.isReversed, false),
        ),
      );
    if (unpaid.length === 0) return null;
    unpaid.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const t = unpaid[0];
    return {
      transactionId: t.id,
      date: toIsoDate(t.date),
      amount: t.amount,
      installmentNumber: t.installmentNumber,
      totalInstallments: t.totalInstallments,
    };
  }

  /** Undo the most recent paid installment (restores wallet/amount from the schedule). */
  async markCurrentAsUnpaid(userId: string, loanAccountId: string) {
    await this.accountService.getById(userId, loanAccountId);
    const paid = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.destinationAccountId, loanAccountId),
          eq(transactions.domainType, 'loan_payment'),
          eq(transactions.isPaid, true),
          eq(transactions.isReversed, false),
        ),
      );
    if (paid.length === 0) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No paid installments to undo' });
    }
    paid.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const updated = await new SettlementService(this.db).unsettle(userId, paid[0].id);
    return { transaction: updated };
  }

  async advanceMonth(userId: string, loanAccountId: string) {
    await this.accountService.getById(userId, loanAccountId);

    const [config] = await this.db
      .select()
      .from(loanConfigs)
      .where(eq(loanConfigs.accountId, loanAccountId));

    if (!config) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Loan config not found' });
    }

    // Compute current installment from paid transactions
    const paidTxs = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.destinationAccountId, loanAccountId),
          eq(transactions.domainType, 'loan_payment'),
          eq(transactions.isPaid, true),
          eq(transactions.isReversed, false),
        ),
      );

    const current = paidTxs.length > 0 ? paidTxs.length : 1;
    if (current >= config.totalInstallments) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Loan is already on the last installment',
      });
    }

    const wallet = await this.accountService.getDefaultWallet(userId);
    if (!wallet) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Defina uma carteira principal para avançar o mês do empréstimo',
      });
    }

    // Mark next unpaid transaction as paid (debits the default wallet)
    const result = await this.markCurrentAsPaid(userId, loanAccountId, wallet.id);

    // Re-materialize to ensure future transactions exist
    await this.materializerService.materializeForUserLocked(userId, 12);

    return { config, currentInstallment: current + 1, transaction: result.transaction };
  }

  async updateCostEvidence(
    userId: string,
    accountId: string,
    raw: z.input<typeof loanCostEvidenceSchema>,
  ) {
    const input = loanCostEvidenceSchema.parse(raw);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const account = await new AccountService(db).getById(userId, accountId);
      if (account.type !== 'loan')
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Loan account required' });
      const [before] = await db
        .select()
        .from(loanConfigs)
        .where(eq(loanConfigs.accountId, accountId))
        .for('update');
      if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Loan config not found' });
      const [updated] = await db
        .update(loanConfigs)
        .set({
          ...(input.annualCet !== undefined
            ? {
                annualCet: input.annualCet?.rate ?? null,
                annualCetSource: input.annualCet?.source ?? null,
                annualCetObservedOn: input.annualCet?.observedOn ?? null,
              }
            : {}),
          ...(input.payoffQuote !== undefined
            ? {
                payoffQuoteAmount: input.payoffQuote?.amount ?? null,
                payoffQuoteOn: input.payoffQuote?.quotedOn ?? null,
                payoffQuoteValidUntil: input.payoffQuote?.validUntil ?? null,
                payoffQuoteSource: input.payoffQuote?.source ?? null,
              }
            : {}),
          ...(input.economicResponsibility !== undefined
            ? { economicResponsibility: input.economicResponsibility }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(loanConfigs.id, before.id))
        .returning();
      await new AuditService(db).log(
        userId,
        'update_cost_evidence',
        'loan',
        accountId,
        before,
        updated,
      );
      return updated;
    });
  }

  async getPayoffInfo(userId: string, loanAccountId: string, asOf: Date = new Date()) {
    const account = await this.accountService.getById(userId, loanAccountId);
    if (account.currency !== 'BRL')
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Payoff comparison requires a BRL loan',
      });

    const [config] = await this.db
      .select({ config: loanConfigs })
      .from(loanConfigs)
      .innerJoin(accounts, and(eq(accounts.id, loanConfigs.accountId), eq(accounts.userId, userId)))
      .where(eq(loanConfigs.accountId, loanAccountId))
      .then((rows) => rows.map((row) => row.config));

    if (!config) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Loan config not found',
      });
    }

    const paid = await this.db
      .selectDistinct({ number: transactions.installmentNumber })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.destinationAccountId, loanAccountId),
          eq(transactions.domainType, 'loan_payment'),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          eq(transactions.isPaid, true),
          ne(transactions.settlementSource, 'date_assumed'),
        ),
      );
    const remaining = Math.max(
      0,
      config.totalInstallments -
        paid.filter(
          (row) => row.number !== null && row.number >= 1 && row.number <= config.totalInstallments,
        ).length,
    );
    const monthlyPayment = Money.fromString(config.monthlyPayment, 'BRL');
    const monthlyInterestRate = Money.fromDecimal(new Decimal(config.monthlyInterestRate), 'BRL');
    const totalIfPaying = monthlyPayment.multiply(remaining);

    const outstandingBalance = !config.payoffCalculationType
      ? totalIfPaying
      : calculateOutstandingBalance({
          type: config.payoffCalculationType as PayoffCalculationType,
          monthlyPayment,
          remainingInstallments: remaining,
          monthlyInterestRate,
        });

    const { savings, savingsPercent } = calculatePayoffSavings(
      monthlyPayment,
      remaining,
      outstandingBalance,
    );
    const payoffQuote = selectPayoffQuote(
      outstandingBalance.toDbString(),
      remaining > 0 &&
        config.payoffQuoteAmount &&
        config.payoffQuoteOn &&
        config.payoffQuoteValidUntil &&
        config.payoffQuoteSource
        ? {
            amount: config.payoffQuoteAmount,
            quotedOn: config.payoffQuoteOn,
            validUntil: config.payoffQuoteValidUntil,
            source: config.payoffQuoteSource,
          }
        : null,
      settlementDateKey(asOf),
    );
    const readiness = await new CashReadinessService(this.db).get(userId, asOf);
    const insurance = Money.fromString(config.insuranceAmount ?? '0', 'BRL');
    const monthlyRelease = remaining > 0 ? monthlyPayment.add(insurance) : Money.zero('BRL');

    return {
      outstandingBalance: outstandingBalance.toDbString(),
      savings: savings.toDbString(),
      savingsPercent,
      remainingInstallments: remaining,
      totalIfPaying: totalIfPaying.toDbString(),
      annualCet:
        config.annualCet !== null
          ? {
              rate: config.annualCet,
              source: config.annualCetSource,
              observedOn: config.annualCetObservedOn,
            }
          : null,
      monthlyNominalRate: config.monthlyInterestRate,
      payoffQuote,
      monthlyRelease: monthlyRelease.toDbString(),
      payrollRelease:
        remaining > 0 && config.paymentMethod === 'payroll' ? monthlyPayment.toDbString() : '0.00',
      bankRelease:
        remaining > 0
          ? (config.paymentMethod === 'payroll' ? insurance : monthlyRelease).toDbString()
          : '0.00',
      paymentMethod: config.paymentMethod,
      economicResponsibility: config.economicResponsibility,
      cashReady: readiness.ready,
      cashReadinessReasons: readiness.reasons,
      availableCash: readiness.ready
        ? Money.fromNumber(readiness.cash.totalCash, 'BRL').toDbString()
        : null,
      exceedsAvailableCash:
        remaining > 0 && readiness.ready
          ? Money.fromString(payoffQuote.selectedAmount, 'BRL').isGreaterThan(
              Money.fromNumber(readiness.cash.totalCash, 'BRL'),
            )
          : null,
    };
  }
}
