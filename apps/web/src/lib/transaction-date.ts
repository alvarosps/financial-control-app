export function transactionDisplayDate(transaction: {
  domainType: string | null;
  date: string | Date;
  purchaseDate?: string | Date | null;
}): string | Date | null {
  return transaction.domainType === 'credit_card_expense' ||
    transaction.domainType === 'credit_card_refund'
    ? (transaction.purchaseDate ?? null)
    : transaction.date;
}
