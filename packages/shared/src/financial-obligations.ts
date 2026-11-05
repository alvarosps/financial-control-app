export type FinancialObligationRef =
  | { kind: 'card_bill'; parentAccountId: string; billingMonth: number; billingYear: number }
  | { kind: 'charge'; transactionId: string }
  | { kind: 'loan_installment'; transactionId: string; loanAccountId: string }
  | { kind: 'income'; transactionId: string }
  | { kind: 'family_receivable'; configId: string; accountId: string; month: number; year: number }
  | { kind: 'other'; transactionId: string };

export type FinancialObligation = {
  oneTime?: boolean;
  settledAt?: string | null;
  canUndo?: boolean;
  statement?: {
    billId: string | null;
    statementId: string;
    dueDateSource: 'institution' | 'user' | 'configuration' | 'unknown';
  };
  key: string;
  ref: FinancialObligationRef;
  name: string;
  direction: 'payable' | 'receivable';
  dueDate: string | null;
  currency: string;
  total: string;
  remaining: string;
  settledAmount: string;
  confirmedCash: string | null;
  status: 'open' | 'partial' | 'settled' | 'needs_review';
  evidence: 'manual' | 'bank' | 'payroll' | 'legacy' | 'assumed';
  action: 'record_payment' | 'record_receipt' | 'open_payroll' | 'review' | 'view_details';
  revision: string;
  accountIds: string[];
  detailHref: string;
};

export type FinancialReviewIssue = {
  key: string;
  name: string;
  reason:
    | 'duplicate_occurrence'
    | 'legacy_bill_payment'
    | 'unclassified_card_movement'
    | 'unknown_cycle'
    | 'missing_amount'
    | 'payroll'
    | 'legacy_settlement';
  transactionIds: string[];
  accountIds: string[];
  detailHref: string;
};
