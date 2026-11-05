const STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na']);

export function normalizeMerchantText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/parc(?:ela)?s?\.?\s*\d{1,2}\s*(?:de|\/)\s*\d{1,2}\b/g, ' ')
    .replace(/parc\.?\d{1,2}\/\d{1,2}\b/g, ' ')
    .replace(/\(?\d{1,2}\/\d{1,2}\)?/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(normalized: string): string[] {
  return normalized.split(' ').filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function compactMerchantText(normalized: string): string {
  return normalized.replace(/\s+/g, '');
}

export function tokenSimilarity(a: string, b: string): number {
  const compactLeft = compactMerchantText(a);
  const compactRight = compactMerchantText(b);
  if (compactLeft.length > 0 && compactLeft === compactRight) return 1;

  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  if (intersection === 0) return 0;

  const jaccard = intersection / (left.size + right.size - intersection);
  const containment = intersection / Math.min(left.size, right.size);
  return Math.max(jaccard, containment * 0.9);
}
