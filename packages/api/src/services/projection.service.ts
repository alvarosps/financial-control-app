import type { DbExecutor } from '@fc/db';
import { Money } from '@fc/domain';
import { ForecastContextService, type ForecastMonth } from './forecast-context.service.ts';
import type { MaterializationGuard } from './materialization-guard.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';

type MonthProjection = {
  month: number;
  year: number;
  income: number;
  balance: number;
  isActual: boolean;
  totalIncome: number;
  totalExpenses: number;
  familyLoanIncome: number;
  creditCardExpenses: number;
  loanExpenses: number;
  recurringExpenses: number;
  forecast: ForecastMonth;
};

export class ProjectionService {
  constructor(
    private db: DbExecutor,
    private guard?: Pick<MaterializationGuard, 'ensureMaterialized'>,
  ) {}

  async get12MonthProjection(userId: string, asOf: Date = new Date()): Promise<MonthProjection[]> {
    const currentMonth = asOf.getMonth() + 1;
    const currentYear = asOf.getFullYear();

    // Materialize the full 12-month horizon up front so future months read real
    // (scheduled) spend instead of 0. The last window month is the farthest
    // point we read; the guard materializes at least that far (and is itself
    // idempotent + advisory-lock-safe, so calling it once here is cheap when
    // already current). Without this, months past the last materialization point
    // understate future expenses.
    if (this.guard) {
      let lastMonth = currentMonth + 11;
      let lastYear = currentYear;
      while (lastMonth > 12) {
        lastMonth -= 12;
        lastYear++;
      }
      await this.guard.ensureMaterialized(userId, lastMonth, lastYear);
    }

    const results: MonthProjection[] = [];
    const summaryService = new MonthSummaryService(this.db);

    const forecast = await new ForecastContextService(this.db).getMonths(
      userId,
      { month: currentMonth, year: currentYear },
      12,
      asOf,
    );

    for (let i = 0; i < 12; i++) {
      let m = currentMonth + i;
      let y = currentYear;
      while (m > 12) {
        m -= 12;
        y++;
      }
      const isActual = y < currentYear || (y === currentYear && m < currentMonth);

      // Expense forecast uses closing-month competence. BalanceProjection uses due dates for cash.
      const s = await summaryService.getSummary(userId, m, y, {
        familyLoanIncomeOverride: Money.fromNumber(forecast[i].familyOwed, 'BRL'),
      });

      results.push({
        forecast: forecast[i],
        month: m,
        year: y,
        income: s.income,
        balance: s.balance,
        isActual,
        totalIncome: s.totalIncome,
        totalExpenses: s.totalExpenses,
        familyLoanIncome: s.familyLoanIncome,
        creditCardExpenses: s.creditCardExpenses,
        loanExpenses: s.loanExpenses,
        recurringExpenses: Money.fromNumber(s.chargeExpenses, 'BRL')
          .add(Money.fromNumber(s.otherExpenses, 'BRL'))
          .toNumber(),
      });
    }

    return results;
  }
}
