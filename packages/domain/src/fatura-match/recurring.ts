import Decimal from 'decimal.js';
import { normalizeMerchantText, tokenSimilarity } from './normalize-text.ts';
import type { HistoryItem, NewItemSuggestion, ParsedItem } from './types.ts';

const TEXT_THRESHOLD = 0.8;
const AMOUNT_TOLERANCE = new Decimal('0.20');

export function suggestNewItemActions(
  newItems: ParsedItem[],
  history: HistoryItem[],
): NewItemSuggestion[] {
  return newItems.map((parsed) => {
    if (parsed.isRefund) {
      return { parsed, suggestedKind: 'add_refund', looksRecurring: false };
    }
    if (parsed.installmentTotal !== null && parsed.installmentTotal > 1) {
      return { parsed, suggestedKind: 'add_installment', looksRecurring: false };
    }
    if (isRecurring(parsed, history)) {
      return { parsed, suggestedKind: 'add_fixed_charge', looksRecurring: true };
    }
    return { parsed, suggestedKind: 'add_expense', looksRecurring: false };
  });
}

function isRecurring(parsed: ParsedItem, history: HistoryItem[]): boolean {
  const description = normalizeMerchantText(parsed.description);
  if (description.length === 0) return false;
  const amount = new Decimal(parsed.amountBRL);
  const months = new Set<string>();
  for (const item of history) {
    if (tokenSimilarity(description, normalizeMerchantText(item.description)) < TEXT_THRESHOLD) {
      continue;
    }
    if (amount.minus(item.amountBRL).abs().gt(AMOUNT_TOLERANCE)) continue;
    months.add(`${item.billingYear}-${item.billingMonth}`);
  }
  return months.size >= 2;
}
