import { Money } from './money.ts';

export type BudgetScope = 'all' | 'own' | 'family' | 'work' | 'property';
export type BudgetExpense = {
  amount: string;
  currency: string;
  categoryId: string | null;
  responsibility: Exclude<BudgetScope, 'all'> | 'unknown';
  phase: 'confirmed' | 'committed' | 'provisional';
  refund: boolean;
  reviewed: boolean;
};

export function budgetProgress(
  limit: string,
  categoryId: string | null,
  scope: BudgetScope,
  expenses: readonly BudgetExpense[],
  sourcesReconciled: boolean,
) {
  const sums = {
    confirmed: Money.zero('BRL'),
    committed: Money.zero('BRL'),
    provisional: Money.zero('BRL'),
    excluded: Money.zero('BRL'),
    uncategorized: Money.zero('BRL'),
    unknownResponsibility: Money.zero('BRL'),
    reviewed: Money.zero('BRL'),
    coverageTotal: Money.zero('BRL'),
  };
  let unsupportedCurrencyCount = 0;
  for (const item of expenses) {
    if (categoryId !== null && item.categoryId !== categoryId) continue;
    if (item.currency !== 'BRL') {
      unsupportedCurrencyCount++;
      continue;
    }
    const absolute = Money.fromString(item.amount, 'BRL');
    const signed = item.refund ? absolute.negate() : absolute;
    const included =
      scope === 'all' ||
      item.responsibility === scope ||
      (scope === 'own' && item.responsibility === 'unknown');
    if (!included) {
      sums.excluded = sums.excluded.add(signed);
      continue;
    }
    sums[item.phase] = sums[item.phase].add(signed);
    if (!item.categoryId) sums.uncategorized = sums.uncategorized.add(signed);
    if (item.responsibility === 'unknown')
      sums.unknownResponsibility = sums.unknownResponsibility.add(signed);
    sums.coverageTotal = sums.coverageTotal.add(absolute);
    if (item.reviewed && item.categoryId && item.phase !== 'provisional')
      sums.reviewed = sums.reviewed.add(absolute);
  }
  const projected = sums.confirmed.add(sums.committed).add(sums.provisional);
  const remaining = Money.fromString(limit, 'BRL').subtract(projected);
  const coveragePercent = sums.coverageTotal.isZero()
    ? 100
    : sums.reviewed.toDecimal().div(sums.coverageTotal.toDecimal()).times(100).toNumber();
  return {
    confirmed: sums.confirmed.toDbString(),
    committed: sums.committed.toDbString(),
    provisional: sums.provisional.toDbString(),
    projected: projected.toDbString(),
    remaining: remaining.toDbString(),
    excluded: sums.excluded.toDbString(),
    uncategorized: sums.uncategorized.toDbString(),
    unknownResponsibility: sums.unknownResponsibility.toDbString(),
    coveragePercent,
    unsupportedCurrencyCount,
    reliable:
      sourcesReconciled &&
      unsupportedCurrencyCount === 0 &&
      coveragePercent >= 90 &&
      sums.provisional.isZero(),
    exceeded: remaining.isNegative(),
    nearLimit: projected.toDecimal().gte(Money.fromString(limit, 'BRL').toDecimal().times('0.9')),
  };
}
