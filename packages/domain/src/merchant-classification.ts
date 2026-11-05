export type MerchantRule = {
  id: string;
  merchant: string;
  cardAccountId: string | null;
  categoryId: string;
  priority: number;
  version: number;
};

export function normalizeMerchant(description: string): string {
  return description
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function suggestMerchantClassification(
  description: string,
  cardAccountId: string | null,
  rules: MerchantRule[],
) {
  const merchant = normalizeMerchant(description);
  const matching = rules
    .filter(
      (rule) =>
        normalizeMerchant(rule.merchant) === merchant &&
        (!rule.cardAccountId || rule.cardAccountId === cardAccountId),
    )
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const first = matching[0];
  if (!first) return null;
  const ambiguous =
    /\b(amazon|mercado livre|shopee|aliexpress|marketplace)\b/u.test(merchant) ||
    matching.some(
      (rule) => rule.priority === first.priority && rule.categoryId !== first.categoryId,
    );
  return {
    categoryId: first.categoryId,
    ruleId: first.id,
    ruleVersion: first.version,
    confidence: ambiguous ? ('ambiguous' as const) : ('exact' as const),
    requiresReview: true as const,
  };
}
