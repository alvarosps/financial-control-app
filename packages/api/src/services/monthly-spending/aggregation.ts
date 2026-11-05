import { Money } from '@fc/domain';
import type {
  CardGroupSummary,
  CreditCardGroup,
  FixedExpenseItem,
  LoanItem,
  OtherExpenseItem,
  SpendingSummary,
} from './types.ts';

export type AggregationInput = {
  month: number;
  year: number;
  creditCards: CreditCardGroup[];
  loans: LoanItem[];
  fixedExpenses: FixedExpenseItem[];
  otherExpenses: OtherExpenseItem[];
};

export type MonthlySpendingResult = {
  month: number;
  year: number;
  summary: SpendingSummary;
  creditCards: CreditCardGroup[];
  loans: LoanItem[];
  fixedExpenses: FixedExpenseItem[];
  otherExpenses: OtherExpenseItem[];
  groceryCards: CreditCardGroup[];
  storeCards: CreditCardGroup[];
  marketplaceLoans: CreditCardGroup[];
  vehicleCards: CreditCardGroup[];
};

const m = (s: string) => Money.fromString(s, 'BRL');
const sumStrings = (xs: string[]) => Money.sum(xs.map(m), 'BRL');

export function buildMonthlySpendingResult(input: AggregationInput): MonthlySpendingResult {
  const { month, year, creditCards, loans, fixedExpenses, otherExpenses } = input;

  const ccTotalMoney = sumStrings(creditCards.map((cc) => cc.total));
  const ccItemCount = creditCards.reduce((sum, cc) => sum + cc.items.length, 0);

  // Split CC items into installments (installmentNumber=1 with totalInstallments>1) vs one-time
  let newInstallmentsMoney = Money.zero('BRL');
  let newInstallmentsCount = 0;
  let oneTimeMoney = Money.zero('BRL');
  let oneTimeCount = 0;

  for (const cc of creditCards) {
    for (const item of cc.items) {
      if (
        item.installmentNumber === 1 &&
        item.totalInstallments !== null &&
        item.totalInstallments > 1
      ) {
        newInstallmentsMoney = newInstallmentsMoney.add(
          m(item.amount).multiply(item.totalInstallments),
        );
        newInstallmentsCount += 1;
      } else {
        oneTimeMoney = oneTimeMoney.add(m(item.amount));
        oneTimeCount += 1;
      }
    }
  }

  // Include loans in newInstallments (they are new commitments starting this month)
  for (const loan of loans) {
    newInstallmentsMoney = newInstallmentsMoney.add(
      m(loan.monthlyPayment).multiply(loan.totalInstallments),
    );
    newInstallmentsCount += 1;
  }

  // Other expenses count as one-time
  for (const other of otherExpenses) {
    oneTimeMoney = oneTimeMoney.add(m(other.amount));
    oneTimeCount += 1;
  }

  const loanTotalMoney = sumStrings(loans.map((l) => l.monthlyPayment));
  const fixedTotalMoney = sumStrings(fixedExpenses.map((f) => f.amount));
  const otherTotalMoney = sumStrings(otherExpenses.map((o) => o.amount));

  const grandTotalMoney = ccTotalMoney
    .add(loanTotalMoney)
    .add(fixedTotalMoney)
    .add(otherTotalMoney);

  const emptyCardGroup: CardGroupSummary = { total: '0.00', count: 0, itemCount: 0 };

  const summary: SpendingSummary = {
    total: grandTotalMoney.toDbString(),
    byType: {
      creditCards: {
        total: ccTotalMoney.toDbString(),
        count: creditCards.length,
        itemCount: ccItemCount,
      },
      grocery: { ...emptyCardGroup },
      storeCards: { ...emptyCardGroup },
      marketplaceLoans: { ...emptyCardGroup },
      vehicle: { ...emptyCardGroup },
      loans: { total: loanTotalMoney.toDbString(), count: loans.length },
      fixedExpenses: { total: fixedTotalMoney.toDbString(), count: fixedExpenses.length },
      other: { total: otherTotalMoney.toDbString(), count: otherExpenses.length },
    },
    newInstallments: {
      total: newInstallmentsMoney.toDbString(),
      count: newInstallmentsCount,
    },
    oneTimeExpenses: {
      total: oneTimeMoney.toDbString(),
      count: oneTimeCount,
    },
  };

  return {
    month,
    year,
    summary,
    creditCards,
    loans,
    fixedExpenses,
    otherExpenses,
    // Sub-categories (placeholder for future grouping)
    groceryCards: [],
    storeCards: [],
    marketplaceLoans: [],
    vehicleCards: [],
  };
}
