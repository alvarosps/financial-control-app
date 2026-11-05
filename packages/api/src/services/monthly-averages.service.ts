import type { DbExecutor } from '@fc/db';
import { scheduledTransactions, transactions } from '@fc/db';
import { type DomainType, detectOutlierMonths, Money, outlierReasons } from '@fc/domain';
import {
  addMonths,
  type InstallmentSuggestion,
  type MonthlyAverages,
  type SpendOutlierMonth,
} from '@fc/shared';
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { MonthSummaryService } from './month-summary.service.ts';

/**
 * Domain types whose rows are individual installment occurrences and therefore
 * carry `installmentNumber` (set by the materializer to the occurrence number;
 * NULL for non-installment rows). A NEW installment plan begins exactly at its
 * first occurrence — `installmentNumber = 1`.
 *
 * We list the installment types explicitly rather than reusing
 * `getDomainTypesByGroup('credit_card')`: that group also contains
 * non-installment card types (`credit_card_expense`, `credit_card_fixed_charge`,
 * `bill_payment`, ...) whose rows have a NULL `installmentNumber`. Scoping to the
 * true installment types keeps the "new installment started" signal exact across
 * card AND loan/family-loan installments.
 */
const INSTALLMENT_DOMAIN_TYPES: DomainType[] = [
  'credit_card_installment',
  'loan_payment',
  'family_loan_installment',
];

/** Default look-back window (complete months before the current month). */
const DEFAULT_WINDOW = 12;

type MonthRecord = {
  month: number;
  year: number;
  totalExpenses: number;
  creditCard: number;
  loan: number;
  charge: number;
  other: number;
  newInstallment: number;
  iof: number;
  hasData: boolean;
};

/**
 * Derives historical averages over the user's last `window` complete calendar
 * months (excluding the current/partial month) to seed the simulator's
 * `average_spend` and `installment_growth` lever defaults. Read-only; every
 * query is scoped to `userId`.
 *
 * Outlier-aware: one-off spikes (e.g. an international trip) are detected with
 * the pure `@fc/domain` detector (median + MAD, plus an IOF trip-signal) over
 * the months that actually have data, and excluded from the TYPICAL average.
 * The unfiltered mean is still returned as `rawAverageMonthlySpend` for
 * transparency, and the excluded months are reported in `excludedMonths`.
 */
export class MonthlyAveragesService {
  constructor(private db: DbExecutor) {}

  async getMonthlyAverages(
    userId: string,
    opts: { window?: number; asOf?: Date } = {},
  ): Promise<MonthlyAverages> {
    const window = opts.window ?? DEFAULT_WINDOW;
    const asOf = opts.asOf ?? new Date();
    const summary = new MonthSummaryService(this.db);
    const curMonth = asOf.getMonth() + 1;
    const curYear = asOf.getFullYear();

    // The `window` complete months immediately before the current month, oldest
    // first.
    const current = { month: curMonth, year: curYear };
    const months: { month: number; year: number }[] = [];
    for (let i = window; i >= 1; i--) {
      months.push(addMonths(current, -i));
    }

    // IOF for the whole window is fetched ONCE and bucketed in memory (a single
    // query instead of one full scan per window month).
    const iofByMonth = await this.iofByMonth(userId, months);

    // Per-month records. Totals/category breakdowns come from
    // MonthSummaryService, which buckets every expense exactly once (cards by
    // closing/billing month, loans + recurring charges + other), so the averages
    // are deduplicated by construction. New-installment and IOF amounts are
    // bucketed per month alongside.
    const records: MonthRecord[] = [];
    for (const w of months) {
      const s = await summary.getSummary(userId, w.month, w.year);
      const newInstallment = await this.newInstallmentForMonth(userId, w.month, w.year);
      const iof = (iofByMonth.get(`${w.year}-${w.month}`) ?? Money.zero('BRL')).toNumber();
      records.push({
        month: w.month,
        year: w.year,
        totalExpenses: s.totalExpenses,
        creditCard: s.creditCardExpenses,
        loan: s.loanExpenses,
        charge: s.chargeExpenses,
        other: s.otherExpenses,
        newInstallment,
        iof,
        // A month "has data" if it recorded any spend or income; empty
        // pre-history months are skipped so a sparse history is averaged over
        // the months that exist.
        hasData: s.totalExpenses !== 0 || s.totalIncome !== 0,
      });
    }

    // Outlier detection runs over DATA months only — empty pre-history months
    // would otherwise drag the median toward zero and flag everything.
    const dataMonths = records.filter((r) => r.hasData);
    const detectorInput = dataMonths.map((d) => ({ total: d.totalExpenses, iof: d.iof }));
    const flags = detectOutlierMonths(detectorInput);
    const reasons = outlierReasons(detectorInput);

    const excludedMonths: SpendOutlierMonth[] = [];
    const typicalMonths: MonthRecord[] = [];
    dataMonths.forEach((d, idx) => {
      if (flags[idx]) {
        excludedMonths.push({
          month: d.month,
          year: d.year,
          total: Money.fromNumber(d.totalExpenses, 'BRL').toDbString(),
          reasons: reasons[idx],
        });
      } else {
        typicalMonths.push(d);
      }
    });

    const monthsWithData = dataMonths.length;
    const monthsUsed = typicalMonths.length;
    const typicalDivisor = Math.max(1, monthsUsed);
    const rawDivisor = Math.max(1, monthsWithData);

    const sumBy = (rows: MonthRecord[], pick: (r: MonthRecord) => number) =>
      rows.reduce((acc, r) => acc.add(Money.fromNumber(pick(r), 'BRL')), Money.zero('BRL'));

    const typicalSpend = sumBy(typicalMonths, (r) => r.totalExpenses);
    const rawSpend = sumBy(dataMonths, (r) => r.totalExpenses);
    const cc = sumBy(typicalMonths, (r) => r.creditCard);
    const loan = sumBy(typicalMonths, (r) => r.loan);
    const charge = sumBy(typicalMonths, (r) => r.charge);
    const other = sumBy(typicalMonths, (r) => r.other);
    const newInstallment = sumBy(typicalMonths, (r) => r.newInstallment);

    return {
      window,
      monthsWithData,
      monthsUsed,
      averageMonthlySpend: typicalSpend.divide(typicalDivisor).toDbString(),
      rawAverageMonthlySpend: rawSpend.divide(rawDivisor).toDbString(),
      averageNewInstallment: newInstallment.divide(typicalDivisor).toDbString(),
      byCategory: {
        creditCard: cc.divide(typicalDivisor).toDbString(),
        loan: loan.divide(typicalDivisor).toDbString(),
        charge: charge.divide(typicalDivisor).toDbString(),
        other: other.divide(typicalDivisor).toDbString(),
      },
      excludedMonths,
    };
  }

  /**
   * Recent installment plans to seed the `installment_plan` lever defaults when
   * the user adds one.
   *
   * Seam: an installment plan is modeled as a `scheduled_transaction` carrying
   * an installment `domainType` (card / loan / family-loan), `startingOccurrence
   * = 1` (the plan begins at its first occurrence — later partial plans start
   * higher) and a non-null `totalOccurrences` (the parcela count N). Read-only,
   * scoped to `userId`, capped at 8, most recent first — `createdAt` desc with
   * `startDate` desc as a deterministic tiebreaker for rows inserted together.
   */
  async getInstallmentSuggestions(userId: string): Promise<InstallmentSuggestion[]> {
    const rows = await this.db
      .select({
        description: scheduledTransactions.description,
        amount: scheduledTransactions.amount,
        totalOccurrences: scheduledTransactions.totalOccurrences,
      })
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.userId, userId),
          inArray(scheduledTransactions.domainType, INSTALLMENT_DOMAIN_TYPES),
          eq(scheduledTransactions.startingOccurrence, 1),
          isNotNull(scheduledTransactions.totalOccurrences),
        ),
      )
      .orderBy(desc(scheduledTransactions.createdAt), desc(scheduledTransactions.startDate))
      .limit(8);

    // The `isNotNull` predicate guarantees a non-null count at the DB level; the
    // type guard narrows `totalOccurrences` from `number | null` to `number`
    // without a non-null assertion.
    return rows
      .filter((r): r is typeof r & { totalOccurrences: number } => r.totalOccurrences !== null)
      .map((r) => ({
        label: r.description,
        amount: Money.fromString(r.amount, 'BRL').toDbString(),
        installments: r.totalOccurrences,
      }));
  }

  /**
   * Sum of newly-started installments whose first occurrence falls in the given
   * calendar month.
   *
   * Seam: a NEW installment is the first occurrence of an installment plan,
   * stamped `installmentNumber = 1` on the `transactions` row by the materializer
   * (later occurrences carry 2, 3, ... and are excluded). The column exists on
   * `transactions`, so we count first occurrences directly there — faithful to
   * "a new installment started in month k" without re-deriving from schedules.
   * The month key is the occurrence `date` (calendar month), independent of the
   * billing-month bucketing used for card spend.
   */
  private async newInstallmentForMonth(
    userId: string,
    month: number,
    year: number,
  ): Promise<number> {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));

    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${transactions.amount}::numeric), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          eq(transactions.installmentNumber, 1),
          inArray(transactions.domainType, INSTALLMENT_DOMAIN_TYPES),
          gte(transactions.date, start),
          lte(transactions.date, end),
        ),
      );

    return Money.fromString(row?.total ?? '0', 'BRL').toNumber();
  }

  /**
   * Sum of IOF charged per window month (the IOF trip-signal feeding the
   * outlier detector), fetched in a SINGLE query and bucketed in memory.
   *
   * Seam: IOF (the Brazilian tax on foreign-currency card spend) has no
   * dedicated column or domain type — it appears as ordinary `transactions`
   * rows whose `description` contains "IOF" (e.g. "IOF compra internacional"),
   * domainType `credit_card_expense`, carrying `billingMonth`/`billingYear`. We
   * therefore match by `description ILIKE '%IOF%'` (userId-scoped, not reversed)
   * and bucket each row by its `billingMonth`/`billingYear` when set — matching
   * how MonthSummaryService buckets card spend, so the IOF signal lands in the
   * same month as the spend it taxes — else by the calendar month of `date`.
   *
   * Perf: rather than re-scanning the user's entire IOF history once per window
   * month, we fetch the relevant rows once and bucket them in JS, returning a
   * Map keyed by `"${year}-${month}"` of summed `Money`. The query is bounded on
   * both ends: `date >= (earliest window month minus one month)` as a lower
   * safety margin so a row whose billing month sits in the window but whose
   * `date` falls slightly before it is still picked up, and `date <= (last day
   * of the newest window month)` as an upper bound so the scan is not unbounded
   * forward. Per `assignBillingPeriod`, when a purchase falls after the card's
   * closing day its billing month is `month + 1`, so billing-month bucketing
   * shifts a row's effective month at most ~1 month FORWARD of its `date` (never
   * backward) — a row's `date` is therefore always at or before its billing month
   * and so `<= upperBound`. A row dated after the newest window month's last day
   * can never bucket into any window month — the upper bound drops nothing.
   * Buckets outside the window are dropped, so the per-month totals are identical
   * to the previous per-month implementation.
   */
  private async iofByMonth(
    userId: string,
    window: { month: number; year: number }[],
  ): Promise<Map<string, Money>> {
    const totals = new Map<string, Money>();
    if (window.length === 0) return totals;

    // Window months are oldest-first; the earliest is window[0] and the newest
    // (most recent) is the last element. The lower safety margin (one month
    // earlier) tolerates rows dated just before a window month they are billed
    // into. The upper bound is the last calendar day of the newest window month:
    // billing-month bucketing only ever shifts a row to a LATER month (a
    // post-closing-day purchase bills in `month + 1`), so a row's `date` is at or
    // before its billing month and a row dated after this day cannot land in any
    // window bucket.
    const earliest = window[0];
    const latest = window[window.length - 1];
    const lowerBound = new Date(Date.UTC(earliest.year, earliest.month - 2, 1));
    const upperBound = new Date(Date.UTC(latest.year, latest.month, 0));
    const windowKeys = new Set(window.map((w) => `${w.year}-${w.month}`));

    const rows = await this.db
      .select({
        amount: transactions.amount,
        billingMonth: transactions.billingMonth,
        billingYear: transactions.billingYear,
        date: transactions.date,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          ilike(transactions.description, '%IOF%'),
          gte(transactions.date, lowerBound),
          lte(transactions.date, upperBound),
        ),
      );

    for (const r of rows) {
      const bucketMonth = r.billingMonth ?? r.date.getUTCMonth() + 1;
      const bucketYear = r.billingYear ?? r.date.getUTCFullYear();
      const key = `${bucketYear}-${bucketMonth}`;
      if (!windowKeys.has(key)) continue;
      const current = totals.get(key) ?? Money.zero('BRL');
      totals.set(key, current.add(Money.fromString(r.amount, 'BRL')));
    }
    return totals;
  }
}
