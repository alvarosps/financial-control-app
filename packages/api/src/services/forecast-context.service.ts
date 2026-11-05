import type { DbExecutor } from '@fc/db';
import { Money } from '@fc/domain';
import { addMonths, type MonthRef } from '@fc/shared';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { FamilyLoanLedgerService } from './family-loan-ledger.service.ts';
import { IncomeOccurrenceService } from './income-occurrence.service.ts';

export class ForecastContextService {
  constructor(private db: DbExecutor) {}

  async getMonths(userId: string, from: MonthRef, horizon: number, asOf: Date) {
    const configs = await new FamilyLoanFlowService(this.db).list(userId);
    const ledgerService = new FamilyLoanLedgerService(this.db);
    const ledgers = await Promise.all(
      configs.map((config) =>
        ledgerService.getLedger(userId, config.id, {
          asOf,
          currentPeriod: from,
          forwardMonths: horizon - 1,
        }),
      ),
    );
    const incomeService = new IncomeOccurrenceService(this.db);
    return Promise.all(
      Array.from({ length: horizon }, async (_, index) => {
        const ref = addMonths(from, index);
        const monthKey = `${ref.year}-${String(ref.month).padStart(2, '0')}`;
        const family = ledgers.flatMap((ledger) =>
          ledger.months.filter((month) => month.monthKey === monthKey),
        );
        const sources = await incomeService.getOccurrences(userId, ref.month, ref.year);
        return {
          ...ref,
          familyOwed: Money.sum(
            family.map((row) => Money.fromNumber(row.owed, 'BRL')),
            'BRL',
          ).toNumber(),
          familyAllocated: Money.sum(
            family.map((row) => Money.fromNumber(row.paid, 'BRL')),
            'BRL',
          ).toNumber(),
          familyRemaining: Money.sum(
            family.map((row) => Money.fromNumber(row.remaining, 'BRL')),
            'BRL',
          ).toNumber(),
          incomeUnavailableCount: sources
            .flatMap((source) => source.occurrences)
            .filter((occ) => occ.amountBrl === null).length,
          payrollDateUncertain: sources.some((source) => source.needsPayrollAllocation),
          sources,
        };
      }),
    );
  }
}

export type ForecastMonth = Awaited<ReturnType<ForecastContextService['getMonths']>>[number];
