import type { DbExecutor } from '@fc/db';
import { transactions } from '@fc/db';
import { and, eq, lte, sql } from 'drizzle-orm';

/** Last calendar day of the month containing `d` (local midnight). */
export function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/**
 * Current installment of a loan = the highest `installment_number` among
 * non-reversed `loan_payment` transactions due on/before the end of `asOf`'s
 * month. Robust to duplicate early installments (uses MAX, not COUNT).
 * Returns 0 when nothing is due yet.
 */
export async function computeCurrentInstallment(
  db: DbExecutor,
  loanAccountId: string,
  asOf: Date = new Date(),
): Promise<number> {
  const [row] = await db
    .select({
      current: sql<number>`COALESCE(MAX(${transactions.installmentNumber}), 0)::int`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.destinationAccountId, loanAccountId),
        eq(transactions.domainType, 'loan_payment'),
        eq(transactions.isReversed, false),
        lte(transactions.date, endOfMonth(asOf)),
      ),
    );
  return row?.current ?? 0;
}

/**
 * Number of UNPAID non-reversed loan_payment transactions due on/before the end
 * of asOf's month (overdue or due this month, not yet paid). 0 means the current
 * month (and all prior) is settled.
 */
export async function countUnpaidInstallmentsThroughMonth(
  db: DbExecutor,
  loanAccountId: string,
  asOf: Date = new Date(),
): Promise<number> {
  const [row] = await db
    .select({ unpaid: sql<number>`COUNT(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.destinationAccountId, loanAccountId),
        eq(transactions.domainType, 'loan_payment'),
        eq(transactions.isReversed, false),
        eq(transactions.isPaid, false),
        lte(transactions.date, endOfMonth(asOf)),
      ),
    );
  return row?.unpaid ?? 0;
}

/**
 * True when the loan has NO unpaid, non-reversed `loan_payment` transaction
 * due on/before the end of `asOf`'s month — i.e. the current month's
 * installment (and all prior) is settled. Mirrors `markCurrentAsPaid`'s
 * oldest-unpaid rule. Future installments (date > month end) are ignored.
 * Returns true when nothing is due yet.
 */
export async function isCurrentMonthInstallmentPaid(
  db: DbExecutor,
  loanAccountId: string,
  asOf: Date = new Date(),
): Promise<boolean> {
  return (await countUnpaidInstallmentsThroughMonth(db, loanAccountId, asOf)) === 0;
}
