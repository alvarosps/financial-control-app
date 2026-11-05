import type { DbExecutor } from '@fc/db';
import {
  accounts,
  incomeSourceConfigs,
  loanConfigs,
  payrollDeductions,
  transactions,
} from '@fc/db';
import { getDomainTypesByGroup, Money } from '@fc/domain';
import type { SettlementSource } from '@fc/shared';
import { and, eq, getTableColumns, gte, inArray, isNull, lte } from 'drizzle-orm';
import { cashValueBrl } from '../lib/cash-selection.ts';
import { incomeEconomicBrl } from '../lib/income-valuation.ts';

function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export type IncomeOccurrence = {
  transactionId: string;
  date: string; // YYYY-MM-DD
  amount: string; // native currency
  currency: string;
  isPaid: boolean;
  exchangeRate: string | null;
  /** Economic BRL value before payroll deductions; null when consolidation lacks a rate. */
  amountBrl: string | null;
  cashAmountBrl: string | null;
  settlementSource: SettlementSource | 'predicted';
  settlementDate: Date | null;
  cashConfirmed: boolean;
  needsPayrollAllocation: boolean;
  payrollDeductionBrl: string;
};

export type IncomeOccurrenceSource = {
  accountId: string;
  name: string;
  currency: string;
  category: string | null;
  frequency: string | null;
  configRate: string | null;
  configUpdatedAt: Date | null;
  /**
   * Income source conversion fee (percent) applied to non-BRL income when
   * converting to BRL. Net BRL = gross × (1 − conversionFeePercent/100).
   * Consumers should use `convertIncomeToBrl` with this value.
   */
  conversionFeePercent: string | null;
  autoCreditByDate: boolean;
  pendingPayrollBrl: string;
  /** Month-wide unresolved obligations; not assigned to this source or additive across sources. */
  unlinkedPayrollBrl: string;
  pendingNetDepositBrl: string | null;
  needsPayrollAllocation: boolean;
  occurrences: IncomeOccurrence[];
};

export class IncomeOccurrenceService {
  constructor(private db: DbExecutor) {}

  /** Per-source income occurrences (materialized rows) within the month window. */
  async getOccurrences(
    userId: string,
    month: number,
    year: number,
  ): Promise<IncomeOccurrenceSource[]> {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    const incomeTypes = getDomainTypesByGroup('income');

    const rows = await this.db
      .select({ ...getTableColumns(transactions), resolvedCashBrl: cashValueBrl })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.domainType, incomeTypes),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          gte(transactions.date, start),
          lte(transactions.date, end),
        ),
      );

    // Load every source account that actually has an occurrence in the window —
    // including DEACTIVATED ones — so occurrences whose revenue source was later
    // deactivated still surface here (daily-control/month-summary still count
    // them; filtering by isActive would make the views silently disagree).
    const sourceIds = [...new Set(rows.map((r) => r.sourceAccountId))];
    const revenueAccounts =
      sourceIds.length > 0
        ? await this.db
            .select()
            .from(accounts)
            .where(and(eq(accounts.userId, userId), inArray(accounts.id, sourceIds)))
        : [];

    const accountIds = revenueAccounts.map((a) => a.id);
    const configs =
      accountIds.length > 0
        ? await this.db
            .select()
            .from(incomeSourceConfigs)
            .where(inArray(incomeSourceConfigs.accountId, accountIds))
        : [];
    const configByAccount = new Map(configs.map((c) => [c.accountId, c]));

    const allocations = rows.length
      ? await this.db
          .select()
          .from(payrollDeductions)
          .where(
            and(
              eq(payrollDeductions.userId, userId),
              inArray(
                payrollDeductions.incomeTransactionId,
                rows.map((row) => row.id),
              ),
              isNull(payrollDeductions.reversedAt),
            ),
          )
      : [];
    const pendingLoans = await this.db
      .select({ sourceId: loanConfigs.incomeSourceAccountId, amount: transactions.amount })
      .from(transactions)
      .innerJoin(loanConfigs, eq(loanConfigs.accountId, transactions.destinationAccountId))
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.domainType, 'loan_payment'),
          eq(transactions.isReversed, false),
          eq(transactions.isPaid, false),
          eq(loanConfigs.paymentMethod, 'payroll'),
          gte(transactions.date, start),
          lte(transactions.date, end),
        ),
      );

    // `amountBrl` is derived per-source below (it needs the source config), so
    // the raw grouping omits it.
    const bySource = new Map<string, typeof rows>();
    for (const tx of rows) {
      const list = bySource.get(tx.sourceAccountId) ?? [];
      list.push(tx);
      bySource.set(tx.sourceAccountId, list);
    }

    const unlinkedPayroll = Money.sum(
      pendingLoans
        .filter((loan) => loan.sourceId === null)
        .map((loan) => Money.fromString(loan.amount, 'BRL')),
      'BRL',
    );

    return revenueAccounts
      .map((account) => {
        const config = configByAccount.get(account.id) ?? null;
        // An unidentified payroll loan cannot withhold unrelated PJ or rental income.
        // Unconfigured sources stay unresolved until their nature is known.
        const hasUnlinkedPayroll =
          !unlinkedPayroll.isZero() &&
          (config === null ||
            config.category === 'salary_clt' ||
            (bySource.get(account.id)?.some((row) => row.domainType === 'income_clt') ?? false));
        const pendingPayroll = Money.sum(
          pendingLoans
            .filter((loan) => loan.sourceId === account.id)
            .map((loan) => Money.fromString(loan.amount, 'BRL')),
          'BRL',
        );
        const occurrences = (bySource.get(account.id) ?? [])
          .sort((a, b) => a.date.getTime() - b.date.getTime())
          .map((occ) => {
            const deductions = allocations.filter(
              (allocation) => allocation.incomeTransactionId === occ.id,
            );
            return {
              transactionId: occ.id,
              date: toIsoDate(occ.date),
              amount: occ.amount,
              currency: occ.currency,
              isPaid: occ.isPaid,
              exchangeRate: occ.exchangeRate,
              amountBrl: incomeEconomicBrl(occ, config, deductions[0]?.grossIncomeBrl ?? null),
              cashAmountBrl: occ.isPaid ? occ.resolvedCashBrl : null,
              settlementSource: occ.isPaid ? occ.settlementSource : ('predicted' as const),
              settlementDate: occ.settlementDate,
              cashConfirmed:
                occ.isPaid &&
                ['manual', 'bank', 'payroll'].includes(occ.settlementSource) &&
                occ.resolvedCashBrl !== null,
              needsPayrollAllocation:
                (!occ.isPaid || occ.settlementSource === 'date_assumed') &&
                (!pendingPayroll.isZero() || hasUnlinkedPayroll),
              payrollDeductionBrl: Money.sum(
                deductions.map((row) => Money.fromString(row.amount, 'BRL')),
                'BRL',
              ).toDbString(),
            };
          });
        const pending = occurrences.filter(
          (occ) => !occ.isPaid || occ.settlementSource === 'date_assumed',
        );
        const pendingNet =
          hasUnlinkedPayroll || pending.some((occ) => occ.amountBrl === null)
            ? null
            : Money.sum(
                pending.map((occ) => Money.fromString(occ.amountBrl ?? '0', 'BRL')),
                'BRL',
              )
                .subtract(pendingPayroll)
                .toDbString();
        return {
          accountId: account.id,
          name: account.name,
          currency: account.currency,
          category: config?.category ?? null,
          frequency: config?.frequency ?? null,
          configRate: config?.exchangeRate ?? null,
          configUpdatedAt: config?.updatedAt ?? null,
          conversionFeePercent: config?.conversionFeePercent ?? null,
          autoCreditByDate: config?.autoCreditByDate ?? false,
          pendingPayrollBrl: pendingPayroll.toDbString(),
          unlinkedPayrollBrl: unlinkedPayroll.toDbString(),
          pendingNetDepositBrl: pendingNet,
          needsPayrollAllocation: !pendingPayroll.isZero() || hasUnlinkedPayroll,
          occurrences,
        };
      })
      .filter((s) => s.occurrences.length > 0);
  }
}
