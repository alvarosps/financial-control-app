import { Money } from '../money.ts';

export type OwedMonth = { monthKey: string; owed: Money };
export type PaymentInput = { date: string; amount: Money };

export type LedgerMonthStatus = 'paid' | 'overdue' | 'partially_paid' | 'open' | 'credit';
export type LedgerMonth = {
  monthKey: string;
  owed: number;
  paid: number;
  remaining: number;
  status: LedgerMonthStatus;
};
export type LedgerTotals = {
  totalOwed: number;
  totalPaid: number;
  totalOutstanding: number;
  totalOverdue: number;
  creditBalance: number;
};
export type FamilyLoanLedger = { months: LedgerMonth[]; totals: LedgerTotals };

/**
 * Allocate payments oldest-first across a chronological owed-by-month series.
 * Pure & deterministic - currentMonthKey is injected (no clock).
 * Negative-owed months are credits (fillable = 0); overpayment overflow becomes
 * creditBalance.
 */
export function allocateFamilyLoanPayments(
  owedByMonth: OwedMonth[],
  payments: PaymentInput[],
  currentMonthKey: string,
): FamilyLoanLedger {
  const months = [...owedByMonth].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  let pool = payments.reduce((acc, p) => acc.add(p.amount), Money.zero('BRL'));

  const out: LedgerMonth[] = [];
  let totalOwed = Money.zero('BRL');
  let totalPaid = Money.zero('BRL');
  let totalOutstanding = Money.zero('BRL');
  let totalOverdue = Money.zero('BRL');
  const zero = Money.zero('BRL');

  for (const { monthKey, owed } of months) {
    totalOwed = totalOwed.add(owed);
    if (owed.isNegative()) {
      // A credit month: the discount/credit magnitude joins the pool so it
      // abates LATER months oldest-first (any leftover becomes creditBalance).
      pool = pool.add(owed.negate());
    }
    const fillable = owed.isNegative() ? zero : owed;
    const applied = pool.isGreaterThan(fillable) ? fillable : pool;
    pool = pool.subtract(applied);
    const remaining = fillable.subtract(applied);
    totalPaid = totalPaid.add(applied);
    // Outstanding = unpaid past + current months only; future months are not
    // outstanding yet (per-month `remaining` is kept for all months for the UI).
    if (monthKey <= currentMonthKey) {
      totalOutstanding = totalOutstanding.add(remaining);
    }

    let status: LedgerMonthStatus;
    if (owed.isNegative()) {
      status = 'credit';
    } else if (remaining.isZero() && owed.isGreaterThan(zero)) {
      status = 'paid';
    } else if (remaining.isGreaterThan(zero) && monthKey < currentMonthKey) {
      status = 'overdue';
      totalOverdue = totalOverdue.add(remaining);
    } else if (applied.isGreaterThan(zero)) {
      status = 'partially_paid';
    } else {
      status = 'open';
    }

    out.push({
      monthKey,
      owed: owed.toNumber(),
      paid: applied.toNumber(),
      remaining: remaining.toNumber(),
      status,
    });
  }

  return {
    months: out,
    totals: {
      totalOwed: totalOwed.toNumber(),
      totalPaid: totalPaid.toNumber(),
      totalOutstanding: totalOutstanding.toNumber(),
      totalOverdue: totalOverdue.toNumber(),
      creditBalance: pool.toNumber(),
    },
  };
}
