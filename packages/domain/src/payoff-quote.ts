import { Money } from './money.ts';
export type PayoffQuote = { amount: string; quotedOn: string; validUntil: string; source: string };
export function selectPayoffQuote(
  estimatedAmount: string,
  quote: PayoffQuote | null,
  targetDate: string,
) {
  const status: 'missing' | 'future' | 'expired' | 'valid' = !quote
    ? 'missing'
    : targetDate < quote.quotedOn
      ? 'future'
      : targetDate > quote.validUntil
        ? 'expired'
        : 'valid';
  return {
    estimatedAmount,
    quotedAmount: quote?.amount ?? null,
    selectedAmount: status === 'valid' && quote ? quote.amount : estimatedAmount,
    basis: status === 'valid' ? ('quote' as const) : ('estimate' as const),
    status,
    difference: quote
      ? Money.fromString(quote.amount, 'BRL')
          .subtract(Money.fromString(estimatedAmount, 'BRL'))
          .toDbString()
      : null,
    source: quote?.source ?? null,
    quotedOn: quote?.quotedOn ?? null,
    validUntil: quote?.validUntil ?? null,
  };
}
