// Money fields are canonical 2dp strings (produced via Money.toDbString()).
// UI parses via Number.parseFloat only at Intl.NumberFormat display time.
import { getDomainTypesByGroup } from '@fc/domain';

export type CreditCardItem = {
  id: string;
  description: string;
  amount: string;
  domainType: string | null;
  direction: 'in' | 'out';
  installmentNumber: number | null;
  totalInstallments: number | null;
  categoryName: string | null;
};

export type CreditCardGroup = {
  cardId: string;
  cardName: string;
  color: string | null;
  total: string;
  items: CreditCardItem[];
};

export type LoanItem = {
  accountId: string;
  name: string;
  installmentNumber: number;
  totalInstallments: number;
  loanType: string;
  monthlyPayment: string;
  originalAmount: string;
  monthlyInterestRate: number;
  annualInterestRate: number;
};

export type FixedExpenseItem = {
  id: string;
  description: string;
  amount: string;
  source: string;
  categoryName: string | null;
  fixedCategory: 'anuidade' | 'assinatura' | 'seguro' | 'conta' | 'outro';
};

export type OtherExpenseItem = {
  id: string;
  description: string;
  amount: string;
  date: string;
  categoryName: string | null;
  sourceAccountName: string;
};

export type CardGroupSummary = { total: string; count: number; itemCount: number };

export type SpendingSummary = {
  total: string;
  byType: {
    creditCards: CardGroupSummary;
    grocery: CardGroupSummary;
    storeCards: CardGroupSummary;
    marketplaceLoans: CardGroupSummary;
    vehicle: CardGroupSummary;
    loans: { total: string; count: number };
    fixedExpenses: { total: string; count: number };
    other: { total: string; count: number };
  };
  newInstallments: { total: string; count: number };
  oneTimeExpenses: { total: string; count: number };
};

export const EXCLUDED_OTHER_DOMAIN_TYPES = new Set<string>([
  'credit_card_installment',
  'credit_card_fixed_charge',
  'loan_payment',
  'bill_payment',
  'loan_insurance',
  // Family-loan rows are internal ledger accounting, never personal "other
  // expenses": charges are what is OWED (netted on the family-loan screen) and
  // discounts are transfers (checking -> family_loan) that only REDUCE the owed
  // total. Without this, family_loan_discount transfers leaked in as personal
  // outflows. Family loans surface as cash ONLY via family_loan_payment.
  ...getDomainTypesByGroup('family_loan'),
]);
