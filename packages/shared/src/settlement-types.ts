export type LoanPaymentMethod = 'bank_debit' | 'payroll' | 'manual';
export type SettlementSource = 'manual' | 'bank' | 'payroll' | 'date_assumed' | 'legacy';
export type CashAnchorBasis = 'recorded' | 'effective';

export type SettlementSnapshot = {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  currency: string;
  exchangeRate: string | null;
  isPaid: boolean;
  paidAt: string | null;
  paidFromAccountId: string | null;
  cashAmount: string | null;
  settlementSource: SettlementSource;
  settlementDate: string | null;
};
