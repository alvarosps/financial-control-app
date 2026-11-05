import type { DbExecutor } from '@fc/db';
import { buildMonthlySpendingResult } from './monthly-spending/aggregation.ts';
import { getCreditCardSpending } from './monthly-spending/credit-cards.ts';
import { getFixedExpenses } from './monthly-spending/fixed-expenses.ts';
import { getLoanSpending } from './monthly-spending/loans.ts';
import { getOtherExpenses } from './monthly-spending/other-expenses.ts';

export type {
  CardGroupSummary,
  CreditCardGroup,
  CreditCardItem,
  FixedExpenseItem,
  LoanItem,
  OtherExpenseItem,
  SpendingSummary,
} from './monthly-spending/types.ts';

export class MonthlySpendingService {
  constructor(private db: DbExecutor) {}

  async getMonthlySpending(userId: string, month: number, year: number) {
    const [creditCards, loans, fixedExpenses, otherExpenses] = await Promise.all([
      getCreditCardSpending(this.db, userId, month, year),
      getLoanSpending(this.db, userId, month, year),
      getFixedExpenses(this.db, userId, month, year),
      getOtherExpenses(this.db, userId, month, year),
    ]);

    return buildMonthlySpendingResult({
      month,
      year,
      creditCards,
      loans,
      fixedExpenses,
      otherExpenses,
    });
  }
}
