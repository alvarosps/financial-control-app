import { transactions } from '@fc/db';
import { sql } from 'drizzle-orm';

/** Preserve both accounting snapshots and closed/paid card statements. */
export function openCardPeriod() {
  return sql`NOT EXISTS (
    SELECT 1 FROM month_closings mc
    CROSS JOIN LATERAL unnest(financial_transaction_dates(to_jsonb(${transactions}))) d
    WHERE mc.user_id = ${transactions.userId} AND mc.year = extract(year FROM d)
      AND mc.month = extract(month FROM d) AND mc.status = 'closed'
  ) AND NOT EXISTS (
    SELECT 1 FROM credit_card_bills cb JOIN accounts a ON a.id = ${transactions.destinationAccountId}
    WHERE cb.credit_card_account_id IN (a.id, a.parent_account_id)
      AND cb.year = ${transactions.billingYear} AND cb.month = ${transactions.billingMonth}
      AND cb.status IN ('closed', 'paid', 'partially_paid')
  )`;
}
