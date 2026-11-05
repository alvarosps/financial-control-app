export type FinancialEventSource = 'manual' | 'pdf' | 'android' | 'pluggy';
export type EventConfirmation = 'observed' | 'pending' | 'posted' | 'retracted';
export type PurchaseReview = 'unreviewed' | 'needs_review' | 'accepted' | 'ignored';
export type PurchaseApplication = 'unapplied' | 'linked' | 'created';
export type AmountMeaning = 'purchase_total' | 'installment' | 'unknown';

/** Only reconciliation fields cross this boundary; raw notifications/documents stay outside it. */
export type FinancialEventData = {
  cardAccountId: string | null;
  description: string;
  amount: string;
  currency: string;
  amountMeaning: AmountMeaning;
  kind: 'purchase' | 'refund';
  purchaseDate: string | null;
  postedDate: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  confirmation: EventConfirmation;
};
