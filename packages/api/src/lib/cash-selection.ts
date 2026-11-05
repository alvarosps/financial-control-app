import { transactions } from '@fc/db';
import { sql } from 'drizzle-orm';

export const cashValueBrl = sql<
  string | null
>`cash_value_brl(${transactions.amount}, ${transactions.currency}, ${transactions.cashAmount})`;
export const cashMovementDay = sql<string>`cash_movement_day(${transactions.date}, ${transactions.settlementDate})`;

export function cashInWindow(
  anchor: Date,
  basis: 'recorded' | 'effective',
  asOf: Date,
  includeAssumed = false,
) {
  return sql`wallet_cash_in_window(${transactions}, ${anchor.toISOString()}::timestamptz, ${basis}, ${asOf.toISOString()}::timestamptz, ${includeAssumed})`;
}
