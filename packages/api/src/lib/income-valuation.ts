import { Money } from '@fc/domain';
import type { SettlementSource } from '@fc/shared';
import { convertIncomeToBrl } from './fx.ts';

type Income = {
  amount: string;
  currency: string;
  isPaid: boolean;
  cashAmount: string | null;
  settlementSource: SettlementSource;
  exchangeRate: string | null;
};

export function incomeEconomicBrl(
  income: Income,
  config: { exchangeRate?: string | null; conversionFeePercent?: string | null } | null,
  payrollGrossBrl: string | null,
): string | null {
  if (income.currency === 'BRL') return Money.fromString(income.amount, 'BRL').toDbString();
  if (income.isPaid && income.settlementSource === 'payroll') return payrollGrossBrl;
  if (income.isPaid && income.cashAmount !== null && income.settlementSource !== 'date_assumed')
    return Money.fromString(income.cashAmount, 'BRL').toDbString();
  try {
    return convertIncomeToBrl(
      Money.fromString(income.amount, income.currency),
      income.currency,
      income.exchangeRate,
      config?.exchangeRate,
      config?.conversionFeePercent,
    ).toDbString();
  } catch {
    return null;
  }
}
