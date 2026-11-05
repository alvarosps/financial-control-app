import { Money } from '@fc/domain';
import type { FinancialEventData } from '@fc/shared';
import type { PluggyTransaction } from './pluggy-types.ts';
export type NormalizedPluggyCard =
  | { kind: 'purchase'; data: FinancialEventData }
  | { kind: 'payment' }
  | { kind: 'review'; reason: string };
export function normalizePluggyCard(
  row: PluggyTransaction,
  cardAccountId: string | null,
  retracted = false,
): NormalizedPluggyCard {
  if (row.operationType === 'PAGAMENTO_FATURA') return { kind: 'payment' };
  const refund = row.operationType === 'ESTORNO';
  if (!refund && row.type !== 'DEBIT') return { kind: 'review', reason: 'unknown_credit' };
  if (!['BRL', 'USD', 'EUR', 'GBP'].includes(row.currencyCode))
    return { kind: 'review', reason: 'unsupported_currency' };
  const amount = Money.fromNumber(row.amount, row.currencyCode).abs();
  if (amount.isZero()) return { kind: 'review', reason: 'zero_amount' };
  const metadata = row.creditCardMetadata;
  const hasInstallments =
    !refund &&
    ((metadata?.totalInstallments ?? 1) > 1 ||
      (metadata?.installmentNumber ?? 1) > 1 ||
      (metadata?.installmentNumber != null && metadata.totalInstallments == null));
  const pair =
    hasInstallments &&
    metadata?.installmentNumber &&
    metadata.totalInstallments &&
    metadata.installmentNumber <= metadata.totalInstallments;
  return {
    kind: 'purchase',
    data: {
      cardAccountId,
      description: row.description.trim().slice(0, 200),
      amount: amount.toDbString(),
      currency: row.currencyCode as FinancialEventData['currency'],
      amountMeaning: hasInstallments ? 'unknown' : 'purchase_total',
      kind: refund ? 'refund' : 'purchase',
      purchaseDate: metadata?.purchaseDate?.slice(0, 10) ?? null,
      postedDate: row.status === 'POSTED' ? row.date.slice(0, 10) : null,
      installmentNumber: pair ? (metadata.installmentNumber ?? null) : null,
      totalInstallments: pair ? (metadata.totalInstallments ?? null) : null,
      confirmation: retracted
        ? 'retracted'
        : row.status === 'POSTED'
          ? 'posted'
          : row.status === 'PENDING'
            ? 'pending'
            : 'observed',
    },
  };
}
