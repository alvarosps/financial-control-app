import type { DbExecutor } from '@fc/db';
import {
  accounts,
  incomeSourceConfigs,
  loanConfigs,
  payrollDeductions,
  transactions,
} from '@fc/db';
import { calculatePayrollSettlement, getDomainTypesByGroup, Money } from '@fc/domain';
import type { SettlementSnapshot } from '@fc/shared';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { convertIncomeToBrl } from '../lib/fx.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { assertOpenSettlementPeriods, settlementDateKey } from '../lib/settlement-guards.ts';
import { AuditService } from './audit.service.ts';

type Transaction = typeof transactions.$inferSelect;
export type PayrollSettlementInput = {
  incomeTransactionId: string;
  loanTransactionIds: string[];
  walletAccountId: string;
  settlementDate: Date;
  reportedNetBrl?: string;
  acknowledgeDifference?: boolean;
};

function snapshot(row: Transaction): SettlementSnapshot {
  return {
    sourceAccountId: row.sourceAccountId,
    destinationAccountId: row.destinationAccountId,
    amount: row.amount,
    currency: row.currency,
    exchangeRate: row.exchangeRate,
    isPaid: row.isPaid,
    paidAt: row.paidAt?.toISOString() ?? null,
    paidFromAccountId: row.paidFromAccountId,
    cashAmount: row.cashAmount,
    settlementSource: row.settlementSource,
    settlementDate: row.settlementDate?.toISOString() ?? null,
  };
}

function restore(value: SettlementSnapshot) {
  return {
    ...value,
    paidAt: value.paidAt ? new Date(value.paidAt) : null,
    settlementDate: value.settlementDate ? new Date(value.settlementDate) : null,
  };
}

function result(income: Transaction, allocations: (typeof payrollDeductions.$inferSelect)[]) {
  const gross = Money.fromString(allocations[0].grossIncomeBrl, 'BRL');
  const deductions = Money.sum(allocations.map((row) => Money.fromString(row.amount, 'BRL')));
  const cash = Money.fromString(income.cashAmount ?? '0', 'BRL');
  return {
    incomeTransactionId: income.id,
    allocationIds: allocations.map((row) => row.id).sort(),
    grossBrl: gross.toDbString(),
    deductionsBrl: deductions.toDbString(),
    expectedNetBrl: gross.subtract(deductions).toDbString(),
    cashAmount: cash.toDbString(),
    differenceBrl: cash.subtract(gross.subtract(deductions)).toDbString(),
  };
}

export class PayrollSettlementService {
  constructor(
    private db: DbExecutor,
    private now: () => Date = () => new Date(),
  ) {}

  async options(userId: string, incomeTransactionId: string) {
    const [income] = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.id, incomeTransactionId),
          eq(transactions.isReversed, false),
        ),
      );
    if (!income?.domainType || !getDomainTypesByGroup('income').includes(income.domainType))
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Income occurrence not found' });
    const allocations = await this.db
      .select()
      .from(payrollDeductions)
      .where(
        and(
          eq(payrollDeductions.userId, userId),
          eq(payrollDeductions.incomeTransactionId, income.id),
          isNull(payrollDeductions.reversedAt),
        ),
      );
    const end = new Date(Date.UTC(income.date.getUTCFullYear(), income.date.getUTCMonth() + 1, 0));
    const candidates = await this.db
      .select({
        transactionId: transactions.id,
        description: transactions.description,
        date: transactions.date,
        amount: transactions.amount,
        loanAccountId: transactions.destinationAccountId,
      })
      .from(transactions)
      .innerJoin(loanConfigs, eq(loanConfigs.accountId, transactions.destinationAccountId))
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.domainType, 'loan_payment'),
          eq(transactions.currency, 'BRL'),
          eq(transactions.isPaid, false),
          eq(transactions.isReversed, false),
          lte(transactions.date, end),
          eq(loanConfigs.paymentMethod, 'payroll'),
          or(
            isNull(loanConfigs.incomeSourceAccountId),
            eq(loanConfigs.incomeSourceAccountId, income.sourceAccountId),
          ),
        ),
      )
      .orderBy(transactions.date, transactions.id)
      .limit(100);
    return { incomeTransactionId, candidates, allocations, cashAmount: income.cashAmount };
  }

  async settle(userId: string, input: PayrollSettlementInput) {
    const loanIds = [...new Set(input.loanTransactionIds)];
    if (
      !loanIds.length ||
      loanIds.length > 100 ||
      loanIds.length !== input.loanTransactionIds.length ||
      loanIds.includes(input.incomeTransactionId)
    ) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select distinct payroll installments' });
    }
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(transactions.id, [input.incomeTransactionId, ...loanIds]),
          ),
        )
        .orderBy(transactions.id)
        .for('update');
      const income = rows.find((row) => row.id === input.incomeTransactionId);
      if (!income || rows.length !== loanIds.length + 1)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Payroll occurrence not found' });
      const loans = rows.filter((row) => row.id !== income.id);
      const active = await db
        .select()
        .from(payrollDeductions)
        .where(
          and(
            eq(payrollDeductions.userId, userId),
            eq(payrollDeductions.incomeTransactionId, income.id),
            isNull(payrollDeductions.reversedAt),
          ),
        );
      if (active.length) {
        if (
          !income.isPaid ||
          income.isReversed ||
          income.settlementSource !== 'payroll' ||
          income.destinationAccountId !== input.walletAccountId ||
          income.settlementDate?.getTime() !== input.settlementDate.getTime() ||
          active.length !== loanIds.length ||
          active.some((row) => !loanIds.includes(row.loanTransactionId)) ||
          loans.some(
            (row) =>
              !row.isPaid ||
              row.isReversed ||
              row.cashAmount !== '0.00' ||
              row.settlementSource !== 'payroll',
          ) ||
          (input.reportedNetBrl !== undefined &&
            Money.fromString(input.reportedNetBrl, 'BRL').toDbString() !== income.cashAmount)
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Existing payroll settlement differs; undo it before changing allocations',
          });
        }
        return result(income, active);
      }
      if (
        rows.some(
          (row) =>
            row.isReversed ||
            (row.isPaid && (row.id !== income.id || row.settlementSource !== 'date_assumed')),
        )
      )
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'An occurrence is already settled or reversed',
        });
      if (!income.domainType || !getDomainTypesByGroup('income').includes(income.domainType))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select an income occurrence' });
      const recordedAt = this.now();
      if (!Number.isFinite(input.settlementDate.getTime()) || input.settlementDate > recordedAt)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid effective settlement date' });
      await assertOpenSettlementPeriods(db, userId, [
        ...rows.map((row) => row.date.toISOString().slice(0, 10)),
        settlementDateKey(input.settlementDate),
      ]);
      const [wallet] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, input.walletAccountId), eq(accounts.userId, userId)))
        .for('update');
      if (!wallet || wallet.type !== 'checking' || wallet.currency !== 'BRL' || !wallet.isActive)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select an active BRL wallet' });
      if (wallet.openingBalanceAnchorAt && input.settlementDate <= wallet.openingBalanceAnchorAt)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Effective date precedes the reconciled wallet anchor; reviewed repair required',
        });
      const configs = await db
        .select()
        .from(loanConfigs)
        .where(
          inArray(
            loanConfigs.accountId,
            loans.map((row) => row.destinationAccountId),
          ),
        )
        .for('update');
      for (const loan of loans) {
        const config = configs.find((item) => item.accountId === loan.destinationAccountId);
        if (
          loan.domainType !== 'loan_payment' ||
          loan.currency !== 'BRL' ||
          config?.paymentMethod !== 'payroll' ||
          (config.incomeSourceAccountId !== null &&
            config.incomeSourceAccountId !== income.sourceAccountId)
        ) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Installment does not belong to the selected payroll income',
          });
        }
      }
      const [incomeConfig] = await db
        .select()
        .from(incomeSourceConfigs)
        .where(eq(incomeSourceConfigs.accountId, income.sourceAccountId));
      let amounts: ReturnType<typeof calculatePayrollSettlement>;
      try {
        amounts = calculatePayrollSettlement({
          grossBrl: convertIncomeToBrl(
            Money.fromString(income.amount, income.currency),
            income.currency,
            income.exchangeRate,
            incomeConfig?.exchangeRate,
            incomeConfig?.conversionFeePercent,
          ),
          deductions: loans.map((row) => ({
            installmentId: row.id,
            amountBrl: Money.fromString(row.amount, 'BRL'),
          })),
          ...(input.reportedNetBrl === undefined
            ? {}
            : { reportedNetBrl: Money.fromString(input.reportedNetBrl, 'BRL') }),
          acknowledgeDifference: input.acknowledgeDifference,
        });
      } catch (cause) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Review payroll amounts and exchange rate',
          cause,
        });
      }
      const [settledIncome] = await db
        .update(transactions)
        .set({
          isPaid: true,
          paidAt: recordedAt,
          paidFromAccountId: wallet.id,
          destinationAccountId: wallet.id,
          cashAmount: amounts.netBrl.toDbString(),
          settlementSource: 'payroll',
          settlementDate: input.settlementDate,
        })
        .where(and(eq(transactions.id, income.id), eq(transactions.userId, userId)))
        .returning();
      await db
        .update(transactions)
        .set({
          isPaid: true,
          paidAt: recordedAt,
          paidFromAccountId: wallet.id,
          cashAmount: '0.00',
          settlementSource: 'payroll',
          settlementDate: input.settlementDate,
        })
        .where(and(eq(transactions.userId, userId), inArray(transactions.id, loanIds)));
      const allocations = await db
        .insert(payrollDeductions)
        .values(
          loans.map((loan) => ({
            userId,
            incomeTransactionId: income.id,
            loanTransactionId: loan.id,
            amount: loan.amount,
            grossIncomeBrl: amounts.grossBrl.toDbString(),
            incomeBefore: snapshot(income),
            loanBefore: snapshot(loan),
          })),
        )
        .returning();
      const applied = result(settledIncome, allocations);
      await new AuditService(db).log(userId, 'settle', 'payroll', income.id, snapshot(income), {
        ...applied,
        settlementDate: input.settlementDate,
        acknowledgeDifference: input.acknowledgeDifference === true,
      });
      return applied;
    });
  }

  async undo(userId: string, incomeTransactionId: string) {
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const [income] = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.id, incomeTransactionId)))
        .for('update');
      if (!income)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Income occurrence not found' });
      const allocations = await db
        .select()
        .from(payrollDeductions)
        .where(
          and(
            eq(payrollDeductions.userId, userId),
            eq(payrollDeductions.incomeTransactionId, income.id),
            isNull(payrollDeductions.reversedAt),
          ),
        )
        .for('update');
      if (!allocations.length) return { incomeTransactionId, status: 'unsettled' as const };
      const loans = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(
              transactions.id,
              allocations.map((row) => row.loanTransactionId),
            ),
          ),
        )
        .orderBy(transactions.id)
        .for('update');
      if (
        !income.isPaid ||
        income.isReversed ||
        loans.length !== allocations.length ||
        income.settlementSource !== 'payroll' ||
        loans.some(
          (row) =>
            !row.isPaid ||
            row.isReversed ||
            row.settlementSource !== 'payroll' ||
            row.cashAmount !== '0.00',
        )
      )
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Payroll state changed; reviewed repair required',
        });
      await assertOpenSettlementPeriods(db, userId, [
        income.date.toISOString().slice(0, 10),
        ...loans.map((row) => row.date.toISOString().slice(0, 10)),
        ...(income.settlementDate ? [settlementDateKey(income.settlementDate)] : []),
      ]);
      await db
        .update(payrollDeductions)
        .set({ reversedAt: this.now(), reversalReason: 'Explicit payroll undo' })
        .where(
          and(
            eq(payrollDeductions.userId, userId),
            inArray(
              payrollDeductions.id,
              allocations.map((row) => row.id),
            ),
          ),
        );
      await db
        .update(transactions)
        .set(restore(allocations[0].incomeBefore))
        .where(and(eq(transactions.id, income.id), eq(transactions.userId, userId)));
      for (const allocation of allocations) {
        await db
          .update(transactions)
          .set(restore(allocation.loanBefore))
          .where(
            and(eq(transactions.id, allocation.loanTransactionId), eq(transactions.userId, userId)),
          );
      }
      await new AuditService(db).log(userId, 'undo', 'payroll', income.id, {
        allocationIds: allocations.map((row) => row.id),
      });
      return { incomeTransactionId, status: 'unsettled' as const };
    });
  }
}
