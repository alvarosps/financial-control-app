import type { DbExecutor } from '@fc/db';
import { accounts, loanConfigs, transactions } from '@fc/db';
import type { LeverEvent, MonthDelta, PayoffCalculationType, ResolvedDelta } from '@fc/domain';
import { calculateOutstandingBalance, Money, selectPayoffQuote } from '@fc/domain';
import { type MonthRef, monthIndex, type SimLever } from '@fc/shared';
import Decimal from 'decimal.js';
import { and, eq, gte, isNull, ne } from 'drizzle-orm';
import {
  addToMonthMap,
  emptyMonthDelta,
  isInMonth,
  monthRefToDate,
  type ResolveContext,
  toByMonth,
} from './resolve-lever.ts';

type LoanPayoffLever = Extract<SimLever, { kind: 'loan_payoff' }>;

/**
 * Resolve a loan payoff into per-month deltas:
 *  - subtract each REAL remaining installment (and active loan_insurance) from the
 *    exact month it falls in, from `targetMonth` onward — never flat-forever, and
 *    never past the loan's last installment (the bug the old test masked).
 *  - apply the payoff lump sum (partialAmount, or calculateOutstandingBalance) as a
 *    one-time OUTFLOW in `targetMonth`. The lump sum (`remaining`) covers ALL
 *    installments still owed from `targetMonth` onward — INCLUDING any that fall
 *    beyond the projection horizon. That is intentional: a payoff settles the
 *    WHOLE loan, so the outflow can legitimately exceed the sum of the
 *    horizon-visible installments it removes.
 *
 * Future-month requirement (current-month guard): a payoff is only well-defined
 * from a FUTURE month. The current-month baseline loan bucket is derived by
 * `MonthOverviewService.toPay.loans`, while this resolver subtracts a raw
 * unpaid-`loan_payment` query (`date >= start-of-targetMonth`). For a
 * `targetMonth` that is the CURRENT calendar month (relative to `ctx.asOf`) those
 * two derivations can diverge → the same installment is over- or under-subtracted
 * (double-count). Rather than reconcile the two queries, we GUARD: if
 * `targetMonth` is at or before the current month we return an all-zero delta
 * (no-op) plus a single annotation event explaining that the payoff month must be
 * in the future. Future-month payoffs are unaffected.
 */
export async function resolveLoanPayoff(
  db: DbExecutor,
  userId: string,
  lever: LoanPayoffLever,
  ctx: ResolveContext,
): Promise<ResolvedDelta> {
  // Current-month guard (M9): a payoff is only well-defined from a FUTURE month.
  // For a current-or-past `targetMonth`, the baseline loan bucket
  // (MonthOverviewService.toPay.loans) and this resolver's raw unpaid-loan_payment
  // subtraction can diverge → double-count. Return an all-zero delta plus a single
  // annotation event that surfaces the reason, instead of emitting a risky delta.
  const currentMonth: MonthRef = { month: ctx.asOf.getMonth() + 1, year: ctx.asOf.getFullYear() };
  if (monthIndex(lever.targetMonth) <= monthIndex(currentMonth)) {
    return {
      leverId: lever.id,
      byMonth: ctx.months.map(emptyMonthDelta),
      events: [
        {
          month: lever.targetMonth.month,
          year: lever.targetMonth.year,
          label: 'Payoff month must be in the future',
          sign: 'outflow',
          amount: '0.00',
        },
      ],
    };
  }

  // Ownership: tenant-scope the config read in the single SELECT by joining
  // accounts and filtering accounts.userId. loan_configs has no userId column
  // and is not RLS-protected, and the shared pool makes RLS runtime-inert — so
  // an unscoped read of a client-supplied loanAccountId would leak another
  // user's config (its comment, monthlyPayment, interest rate). With the join,
  // a foreign or unknown loan returns no row, and we yield an empty delta
  // WITHOUT throwing — this mirrors the savings_goal branch's empty
  // ResolvedDelta and does not leak the existence of another user's loan.
  const [config] = await db
    .select({
      monthlyPayment: loanConfigs.monthlyPayment,
      monthlyInterestRate: loanConfigs.monthlyInterestRate,
      payoffCalculationType: loanConfigs.payoffCalculationType,
      comment: loanConfigs.comment,
      totalInstallments: loanConfigs.totalInstallments,
      startDate: loanConfigs.startDate,
      payoffQuoteAmount: loanConfigs.payoffQuoteAmount,
      payoffQuoteOn: loanConfigs.payoffQuoteOn,
      payoffQuoteValidUntil: loanConfigs.payoffQuoteValidUntil,
      payoffQuoteSource: loanConfigs.payoffQuoteSource,
      economicResponsibility: loanConfigs.economicResponsibility,
      paymentMethod: loanConfigs.paymentMethod,
    })
    .from(loanConfigs)
    .innerJoin(accounts, eq(accounts.id, loanConfigs.accountId))
    .where(and(eq(loanConfigs.accountId, lever.loanAccountId), eq(accounts.userId, userId)));

  if (!config) {
    return { leverId: lever.id, byMonth: ctx.months.map(emptyMonthDelta), events: [] };
  }

  const targetStart = monthRefToDate(lever.targetMonth);
  const targetKey = `${lever.targetMonth.year}-${String(lever.targetMonth.month).padStart(2, '0')}-01`;
  if (!config.startDate) {
    return {
      leverId: lever.id,
      byMonth: ctx.months.map(emptyMonthDelta),
      events: [
        {
          ...lever.targetMonth,
          label: 'Loan payoff requires a reviewed first installment date',
          sign: 'outflow',
          amount: '0.00',
        },
      ],
    };
  }
  const elapsed = Math.max(
    0,
    monthIndex(lever.targetMonth) -
      monthIndex({
        month: config.startDate.getUTCMonth() + 1,
        year: config.startDate.getUTCFullYear(),
      }),
  );
  const paid = await db
    .selectDistinct({ number: transactions.installmentNumber })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.destinationAccountId, lever.loanAccountId),
        eq(transactions.domainType, 'loan_payment'),
        eq(transactions.isReversed, false),
        isNull(transactions.reversesTransactionId),
        eq(transactions.isPaid, true),
        ne(transactions.settlementSource, 'date_assumed'),
      ),
    );
  const remaining = Math.max(
    0,
    config.totalInstallments -
      elapsed -
      paid.filter(
        (row) =>
          row.number !== null && row.number > elapsed && row.number <= config.totalInstallments,
      ).length,
  );
  if (remaining === 0)
    return { leverId: lever.id, byMonth: ctx.months.map(emptyMonthDelta), events: [] };

  // Real remaining installments: unpaid, non-reversed loan_payment rows scoped to
  // this user + loan, due on/after the start of targetMonth.
  const installmentRows = await db
    .select({ date: transactions.date, amount: transactions.amount })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.destinationAccountId, lever.loanAccountId),
        eq(transactions.domainType, 'loan_payment'),
        eq(transactions.isReversed, false),
        isNull(transactions.reversesTransactionId),
        eq(transactions.isPaid, false),
        gte(transactions.date, targetStart),
      ),
    );

  // Active loan_insurance schedule occurrences also disappear after payoff.
  const insuranceRows = await db
    .select({ date: transactions.date, amount: transactions.amount })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.destinationAccountId, lever.loanAccountId),
        eq(transactions.domainType, 'loan_insurance'),
        eq(transactions.isReversed, false),
        isNull(transactions.reversesTransactionId),
        eq(transactions.isPaid, false),
        gte(transactions.date, targetStart),
      ),
    );

  const accumulator = new Map<string, { income: Money; expense: Money }>();

  // Subtract each real installment/insurance occurrence from the month it falls in.
  for (const row of [...installmentRows, ...insuranceRows]) {
    const date = typeof row.date === 'string' ? new Date(row.date) : row.date;
    const ref = ctx.months.find((m) => isInMonth(date, m));
    if (!ref) continue; // beyond the horizon window — ignore
    addToMonthMap(accumulator, ref, 'expense', Money.fromString(row.amount, 'BRL').negate());
  }

  // Lump sum = explicit partial, or the computed outstanding balance.
  let lumpSum: Money;
  if (lever.partialAmount !== undefined) {
    lumpSum = Money.fromString(lever.partialAmount, 'BRL');
  } else {
    // Contractual remaining term survives a bounded rematerialization. Earlier
    // installments are assumed paid by the simulated future settlement date.
    const monthlyPayment = Money.fromString(config.monthlyPayment, 'BRL');
    const interestRateNum = Number(config.monthlyInterestRate);
    if (config.payoffCalculationType && interestRateNum > 0) {
      lumpSum = calculateOutstandingBalance({
        type: config.payoffCalculationType as PayoffCalculationType,
        monthlyPayment,
        remainingInstallments: remaining,
        monthlyInterestRate: Money.fromDecimal(new Decimal(config.monthlyInterestRate), 'BRL'),
      });
    } else {
      lumpSum = monthlyPayment.multiply(remaining);
    }
  }

  const quote = selectPayoffQuote(
    lumpSum.toDbString(),
    config.payoffQuoteAmount &&
      config.payoffQuoteOn &&
      config.payoffQuoteValidUntil &&
      config.payoffQuoteSource
      ? {
          amount: config.payoffQuoteAmount,
          quotedOn: config.payoffQuoteOn,
          validUntil: config.payoffQuoteValidUntil,
          source: config.payoffQuoteSource,
        }
      : null,
    targetKey,
  );
  const basis =
    lever.partialAmount !== undefined
      ? 'user assumption: full settlement'
      : `${quote.basis} (${quote.status})`;
  if (lever.partialAmount === undefined) lumpSum = Money.fromString(quote.selectedAmount, 'BRL');

  const events: LeverEvent[] = [];
  const targetRef = ctx.months.find(
    (m) => m.month === lever.targetMonth.month && m.year === lever.targetMonth.year,
  );
  if (targetRef && lumpSum.isPositive()) {
    addToMonthMap(accumulator, targetRef, 'expense', lumpSum);
    events.push({
      month: targetRef.month,
      year: targetRef.year,
      label: `${config.comment ?? 'Loan payoff'} · ${basis} · ${config.economicResponsibility} · ${config.paymentMethod ?? 'unknown'}; prior installments paid and insurance cancelled assumed`,
      sign: 'outflow',
      amount: lumpSum.toDbString(),
    });
  }

  const byMonth: MonthDelta[] = toByMonth(ctx.months, accumulator);
  return { leverId: lever.id, byMonth, events };
}
