import { normalizeMerchant } from './merchant-classification.ts';
import { Money } from './money.ts';

export type RecurringEvidence = {
  id: string;
  date: string;
  amount: string;
  currency: string;
  description: string;
  cardAccountId: string;
  actual: boolean;
};
export function recurringCandidates(evidence: readonly RecurringEvidence[], asOf: string) {
  const groups = new Map<string, RecurringEvidence[]>();
  for (const item of evidence) {
    if (
      !item.actual ||
      item.date > asOf ||
      item.currency !== 'BRL' ||
      !Money.fromString(item.amount, 'BRL').isPositive()
    )
      continue;
    const merchant = normalizeMerchant(item.description);
    if (/\b(amazon|mercado livre|shopee|aliexpress|marketplace)\b/u.test(merchant)) continue;
    const key = JSON.stringify([item.cardAccountId, merchant]);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const result = [];
  for (const values of groups.values()) {
    const byDate = new Map<string, RecurringEvidence>();
    for (const value of values.sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    ))
      byDate.set(value.date, value);
    const samples = [...byDate.values()].slice(-6);
    if (samples.length < 3) continue;
    const gaps = samples
      .slice(1)
      .map((v, i) => (Date.parse(v.date) - Date.parse(samples[i].date)) / 86_400_000);
    if (gaps.some((gap) => !Number.isFinite(gap) || gap < 25 || gap > 35)) continue;
    const prior = samples
      .slice(0, -1)
      .map((v) => Money.fromString(v.amount, 'BRL').toDecimal())
      .sort((a, b) => a.comparedTo(b));
    const median = prior[Math.floor(prior.length / 2)];
    const tolerance = median.times('0.05').greaterThan(2)
      ? median.times('0.05')
      : Money.fromString('2.00', 'BRL').toDecimal();
    if (prior.some((value) => value.minus(median).abs().greaterThan(tolerance))) continue;
    const latest = samples[samples.length - 1];
    result.push({
      merchant: normalizeMerchant(latest.description),
      cardAccountId: latest.cardAccountId,
      count: samples.length,
      sampleIds: samples.map((s) => s.id),
      sampleDates: samples.map((s) => s.date),
      intervalMinDays: 25,
      intervalMaxDays: 35,
      previousAmount: Money.fromDecimal(median, 'BRL').toDbString(),
      latestAmount: Money.fromString(latest.amount, 'BRL').toDbString(),
      toleranceAmount: Money.fromDecimal(tolerance, 'BRL').toDbString(),
      priceChanged: Money.fromString(latest.amount, 'BRL')
        .toDecimal()
        .minus(median)
        .abs()
        .greaterThan(tolerance),
      requiresReview: true as const,
    });
  }
  return result.sort(
    (a, b) =>
      a.cardAccountId.localeCompare(b.cardAccountId) || a.merchant.localeCompare(b.merchant),
  );
}
