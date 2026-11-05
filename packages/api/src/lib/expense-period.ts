import { transactions } from '@fc/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

export function expensePeriodScope(userId: string, month: number, year: number) {
  return and(
    eq(transactions.userId, userId),
    eq(transactions.isReversed, false),
    isNull(transactions.reversesTransactionId),
    sql`(${transactions.domainType}::text LIKE 'credit_card_%' OR ${transactions.domainType}::text IN ('loan_payment','loan_insurance','recurring_bill') OR (${transactions.domainType} IS NULL AND ${transactions.type} = 'withdrawal'))`,
    or(
      and(
        sql`${transactions.domainType}::text LIKE 'credit_card_%'`,
        eq(transactions.billingMonth, month),
        eq(transactions.billingYear, year),
      ),
      and(
        sql`(${transactions.domainType} IS NULL OR ${transactions.domainType}::text NOT LIKE 'credit_card_%' OR ${transactions.billingMonth} IS NULL)`,
        sql`EXTRACT(MONTH FROM ${transactions.date}) = ${month} AND EXTRACT(YEAR FROM ${transactions.date}) = ${year}`,
      ),
    ),
  );
}

export function transactionPeriodDates(row: typeof transactions.$inferSelect) {
  return [
    row.date.toISOString().slice(0, 10),
    ...(row.billingMonth && row.billingYear
      ? [`${row.billingYear}-${String(row.billingMonth).padStart(2, '0')}-01`]
      : []),
  ];
}
