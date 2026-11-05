import type { DbExecutor } from '@fc/db';
import { accounts, loanConfigs, scheduledTransactions, transactions } from '@fc/db';
import { Money } from '@fc/domain';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { localDayWindow, monthsInLocalWindow, parseIsoDate, toIso } from '../lib/calendar-dates.ts';
import type { MaterializationGuardLike } from '../lib/materialization-guard.ts';
import { BillService } from './bill.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { FinancialObligationsService } from './financial-obligations.service.ts';
import { endOfMonth } from './loan-installment.ts';
import { MaterializationGuard } from './materialization-guard.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';

/**
 * Index key for a materialized charge occurrence, by schedule + calendar month.
 * Mirrors findMaterializedCharge's `[firstOfMonth(dueDate), lastOfMonth(dueDate)]`
 * window: an occurrence matches a lookup iff they share the same `(year, month0)`.
 *
 * Takes explicit integers (`month0` is 0-indexed) rather than a Date so the key is
 * TIMEZONE-INDEPENDENT. The `transactions.date` column is UTC-midnight (see
 * `month-summary.service.ts` / `materializer.service.ts#toLocalCalendarDay`), so
 * callers MUST derive year/month0 from the stored date via UTC getters — never
 * local `getMonth()`, which shifts a first-of-month date back a month in a
 * negative-offset TZ (UTC−3) and would mis-key the occurrence.
 */
function occKey(scheduleId: string, year: number, month0: number): string {
  return `${scheduleId}|${year}-${month0}`;
}

export type UpcomingItem = {
  kind: 'card' | 'loan' | 'fixed_charge' | 'one_time_charge';
  id: string;
  name: string;
  dueDate: string; // YYYY-MM-DD
  amount: number;
  isPaid: boolean;
  /** Present iff kind === 'card' — routes `creditCard.payBill({ month, year })`. */
  billingMonth?: number;
  /** Present iff kind === 'card'. */
  billingYear?: number;
  /**
   * Present iff kind is 'fixed_charge' | 'one_time_charge' AND the occurrence is
   * already materialized — id of that materialized transaction so the client can
   * route `charges.markOccurrenceAsPaid({ transactionId })`.
   */
  transactionId?: string;
};

export class DashboardService {
  /**
   * `guard` defaults to a real `MaterializationGuard` (dashboard reads keep their
   * read-time materialization). Read-only callers pass `noOpGuard` so the read
   * never triggers materializer writes.
   */
  constructor(
    private db: DbExecutor,
    private guard: MaterializationGuardLike = new MaterializationGuard(db),
  ) {}

  async getUpcomingObligations(userId: string, days = 30, asOf = new Date()) {
    const { inWindow } = localDayWindow(asOf, days);
    const items = [];
    for (const { month, year } of monthsInLocalWindow(asOf, days)) {
      const result = await new FinancialObligationsService(this.db, this.guard).listForDuePeriod(
        userId,
        month,
        year,
      );
      items.push(
        ...result.items.filter(
          (i) =>
            i.direction === 'payable' &&
            (i.status === 'open' || i.status === 'partial') &&
            i.dueDate &&
            inWindow(parseIsoDate(i.dueDate)),
        ),
      );
    }
    return items.sort(
      (a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.key.localeCompare(b.key),
    );
  }

  async getMonthlySummary(userId: string, month: number, year: number) {
    const summary = await new MonthSummaryService(this.db).getSummary(userId, month, year);
    return {
      month,
      year,
      income: summary.totalIncome,
      expenses: summary.totalExpenses,
      balance: summary.balance,
    };
  }

  /**
   * Upcoming OUTFLOWS within [today, today+days], aggregated by SOURCE ENTITY —
   * never raw materialized installment rows and never income:
   *  - Cards: one item per card from the consolidated fatura (BillService).
   *  - Loans: one item per active loan with a current installment due.
   *  - Charges: active `recurring_bill` schedules (fixed monthly + one-time).
   */
  async getUpcomingItems(
    userId: string,
    days = 30,
    asOf: Date = new Date(),
  ): Promise<UpcomingItem[]> {
    const { inWindow } = localDayWindow(asOf, days);
    const spannedMonths = monthsInLocalWindow(asOf, days);
    const items: UpcomingItem[] = [];

    // Calendar windows use persisted dates, including cycles outside the usual two-month range.
    const billService = new BillService(this.db, this.guard);
    const seenCardDue = new Set<string>();
    for (const { year, month } of spannedMonths) {
      const bills = await billService.getBillsDueInMonth(userId, month, year);
      for (const b of bills) {
        // Use the still-owed remainder, not the full fatura total: the planner
        // running balance (saldoCorrente) starts from real cash, so emitting the
        // gross total for a partially-paid fatura double-subtracts the already-paid
        // charges. `unpaidTotal = max(total - paidTotal, 0)`; skip net-covered
        // faturas. Aligns the per-item amount with computePaidToPay.
        if (b.dueDate == null || b.unpaidTotal <= 0) continue;
        const dueDate = parseIsoDate(b.dueDate);
        if (!inWindow(dueDate)) continue;
        const dedupKey = b.statementId;
        if (seenCardDue.has(dedupKey)) continue;
        seenCardDue.add(dedupKey);
        items.push({
          kind: 'card',
          id: b.cardId,
          name: b.cardName,
          dueDate: b.dueDate,
          amount: b.unpaidTotal,
          isPaid: b.isPaid,
          billingMonth: b.month,
          billingYear: b.year,
        });
      }
    }

    // 2. Loans — one item per active loan per month the window spans, when an
    // installment is due that month.
    const loanAccounts = await this.db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(
        and(eq(accounts.userId, userId), eq(accounts.type, 'loan'), eq(accounts.isActive, true)),
      );
    const loanIds = loanAccounts.map((l) => l.id);

    // Batch (A): all loan configs in one query (was N+1: one select per loan).
    const loanConfigRows = loanIds.length
      ? await this.db.select().from(loanConfigs).where(inArray(loanConfigs.accountId, loanIds))
      : [];
    const configByLoan = new Map(loanConfigRows.map((c) => [c.accountId, c]));

    // Batch (B): all non-reversed loan_payment rows for these loans in one query
    // (was N+1: computeCurrentInstallment + isCurrentMonthInstallmentPaid ran a
    // query per loan PER spanned month). Installment state is then computed
    // in-memory, mirroring the helpers' exact SQL semantics. The `transactions.date`
    // column is UTC-midnight (Drizzle `date` mode:'date'; same convention as
    // `month-summary.service.ts` and `materializer.service.ts#toLocalCalendarDay`).
    // The comparison here is DAY-granular against `endOfMonth(dueDate)` (the last
    // calendar day, far from any midnight edge), so `.getTime() <= cutoff` is
    // TZ-invariant — the UTC↔local midnight offset never crosses the month-end
    // boundary — and is the faithful equivalent of the helpers' `lte(date, endOfMonth)`.
    const loanPayRows = loanIds.length
      ? await this.db
          .select({
            loanId: transactions.destinationAccountId,
            installmentNumber: transactions.installmentNumber,
            isPaid: transactions.isPaid,
            date: transactions.date,
          })
          .from(transactions)
          .where(
            and(
              inArray(transactions.destinationAccountId, loanIds),
              eq(transactions.domainType, 'loan_payment'),
              eq(transactions.isReversed, false),
            ),
          )
      : [];
    const loanPayByLoan = new Map<string, typeof loanPayRows>();
    for (const row of loanPayRows) {
      const bucket = loanPayByLoan.get(row.loanId);
      if (bucket) bucket.push(row);
      else loanPayByLoan.set(row.loanId, [row]);
    }
    // Mirrors computeCurrentInstallment: COALESCE(MAX(installment_number),0)
    // among the loan's rows due on/before endOfMonth(dueDate). null → 0.
    const currentInstallment = (loanId: string, dueDate: Date): number => {
      const cutoff = endOfMonth(dueDate).getTime();
      let max = 0;
      for (const row of loanPayByLoan.get(loanId) ?? []) {
        if (row.date.getTime() <= cutoff) {
          const n = row.installmentNumber ?? 0;
          if (n > max) max = n;
        }
      }
      return max;
    };
    // Mirrors isCurrentMonthInstallmentPaid: true iff NO unpaid row is due
    // on/before endOfMonth(dueDate) (countUnpaidInstallmentsThroughMonth === 0).
    const installmentPaid = (loanId: string, dueDate: Date): boolean => {
      const cutoff = endOfMonth(dueDate).getTime();
      for (const row of loanPayByLoan.get(loanId) ?? []) {
        if (row.isPaid === false && row.date.getTime() <= cutoff) return false;
      }
      return true;
    };

    for (const loan of loanAccounts) {
      const cfg = configByLoan.get(loan.id);
      if (!cfg?.dueDay || cfg.paymentMethod === 'payroll') continue;
      for (const { year, month } of spannedMonths) {
        // Clamp the due day to the month length so a dueDay > month length (e.g.
        // 31 in a 30-day month, or any day past Feb's end) does NOT roll over
        // into the next month and mis-bucket the item.
        const day = Math.min(cfg.dueDay, new Date(year, month, 0).getDate());
        const dueDate = new Date(year, month - 1, day);
        if (!inWindow(dueDate)) continue;
        // Evaluate installment state against that occurrence's month.
        const current = currentInstallment(loan.id, dueDate);
        if (current <= 0) continue;
        items.push({
          kind: 'loan',
          id: loan.id,
          name: loan.name,
          dueDate: toIso(dueDate),
          amount: Number(cfg.monthlyPayment),
          isPaid: installmentPaid(loan.id, dueDate),
        });
      }
    }

    // 3. Charges — active recurring_bill schedules (fixed monthly + one-time).
    const charges = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.userId, userId),
          eq(scheduledTransactions.domainType, 'recurring_bill'),
          eq(scheduledTransactions.isActive, true),
        ),
      );

    // Batch (C): all materialized occurrences for these schedules across the full
    // window range in ONE query (was N+1: findMaterializedCharge ran a per-charge
    // query per occurrence). Indexed by `(scheduleId, year-month)` since the window
    // spans multiple months. Mirrors findMaterializedCharge: non-reversed,
    // userId-scoped, matched by scheduledTransactionId, FIRST-writer wins (the
    // helper's LIMIT 1).
    //
    // Range: [first spanned month start, last spanned month end]. Every lookup
    // date is `inWindow`-gated (one-time `startDate` and each fixed-charge
    // occurrence), and `monthsInLocalWindow` covers every month the window spans,
    // so each lookup's calendar month is a spanned month — its first/last day
    // falls inside this range. No in-window occurrence can be missed.
    const chargeIds = charges.map((c) => c.id);
    const occByKey = new Map<string, { id: string; isPaid: boolean }>();
    if (chargeIds.length && spannedMonths.length) {
      const first = spannedMonths[0];
      const last = spannedMonths[spannedMonths.length - 1];
      // UTC-constructed boundaries: the `date` column is UTC-midnight, so local
      // construction would shift the serialized month edges by a day in some
      // timezones (off-by-one at boundaries). Matches MonthSummaryService.
      const rangeStart = new Date(Date.UTC(first.year, first.month - 1, 1));
      const rangeEnd = new Date(Date.UTC(last.year, last.month, 0));
      // Mirrors findMaterializedCharge exactly: match by userId +
      // scheduledTransactionId + non-reversed, within the month range. The helper
      // did NOT filter on domain_type (it keyed off scheduledTransactionId), so
      // neither do we — preserving byte-for-byte behavior. The inArray already
      // restricts to recurring_bill schedules (the `charges` set).
      const occRows = await this.db
        .select({
          id: transactions.id,
          isPaid: transactions.isPaid,
          scheduledTransactionId: transactions.scheduledTransactionId,
          date: transactions.date,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.isReversed, false),
            inArray(transactions.scheduledTransactionId, chargeIds),
            gte(transactions.date, rangeStart),
            lte(transactions.date, rangeEnd),
          ),
        );
      for (const occ of occRows) {
        if (occ.scheduledTransactionId === null) continue;
        // The stored date is UTC-midnight → derive its calendar month via UTC
        // getters (local getMonth() would shift a first-of-month row back a month
        // in UTC−3 and mis-key the occurrence).
        const key = occKey(
          occ.scheduledTransactionId,
          occ.date.getUTCFullYear(),
          occ.date.getUTCMonth(),
        );
        // First-writer-wins, mirroring findMaterializedCharge's LIMIT 1: a
        // monthly/once schedule has at most one occurrence per calendar month.
        if (!occByKey.has(key)) occByKey.set(key, { id: occ.id, isPaid: occ.isPaid });
      }
    }

    for (const c of charges) {
      const amount = Number(c.amount);
      const start = c.startDate instanceof Date ? c.startDate : new Date(c.startDate);
      if (c.frequency === 'once') {
        // One-time charge: a single occurrence on its startDate. The schedule
        // row has no isPaid column, so read the real paid state from its linked
        // materialized transaction (an already-settled charge must not show as
        // an outstanding alert).
        // `startDate` is UTC-midnight (date mode:'date'); build a LOCAL-midnight
        // date from its UTC components to avoid timezone shifts.
        const baseDate = new Date(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
        if (!inWindow(baseDate)) continue;
        // Match the row-side UTC-derived key. The start date's calendar month
        // in UTC was used to index the occurrences.
        const materialized =
          occByKey.get(occKey(c.id, start.getUTCFullYear(), start.getUTCMonth())) ?? null;
        items.push({
          kind: 'one_time_charge',
          id: c.id,
          name: c.description,
          dueDate: toIso(baseDate),
          amount,
          isPaid: materialized?.isPaid ?? false,
          transactionId: materialized?.id,
        });
        continue;
      }
      // Fixed charge: one occurrence per month the window spans, on its dueDay.
      const rawDay = c.dueDay ?? start.getUTCDate();
      for (const { year, month } of spannedMonths) {
        // Clamp the due day to the month length so a dueDay > month length (e.g.
        // 31 in a 30-day month, or any day past Feb's end) does NOT roll over
        // into the next month and mis-bucket the item.
        const day = Math.min(rawDay, new Date(year, month, 0).getDate());
        const dueDate = new Date(year, month - 1, day);
        if (!inWindow(dueDate)) continue;
        // BUG FIX: read the real paid-state from the month's materialized
        // occurrence (was hard-coded false — a paid fixed charge never showed
        // "Pago"). No materialized row → isPaid:false, transactionId undefined.
        // Key by the loop's known integers (1-indexed `month` → 0-indexed via
        // `month - 1`) so it matches the row-side UTC-derived key regardless of TZ.
        const materialized = occByKey.get(occKey(c.id, year, month - 1)) ?? null;
        items.push({
          kind: 'fixed_charge',
          id: c.id,
          name: c.description,
          dueDate: toIso(dueDate),
          amount,
          isPaid: materialized?.isPaid ?? false,
          transactionId: materialized?.id,
        });
      }
    }

    return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  async getCashFlow(userId: string, months: number = 6) {
    const now = new Date();
    const periods: Array<{ month: number; year: number }> = [];

    for (let i = months - 1; i >= 0; i--) {
      const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      periods.push({ month: targetDate.getMonth() + 1, year: targetDate.getFullYear() });
    }

    const fromDate = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const from = { month: fromDate.getMonth() + 1, year: fromDate.getFullYear() };
    const to = { month: now.getMonth() + 1, year: now.getFullYear() };

    // Precompute the full family-loan range once per config. Passing this
    // equivalent monthly owed amount avoids repeating configs × getMonthlyTotal
    // for every summary in the cash-flow horizon.
    const flow = new FamilyLoanFlowService(this.db);
    const configs = await flow.list(userId);
    const familyIncomeByMonth = new Map<string, Money>();
    for (const config of configs) {
      const owed = await flow.owedByMonthRange(userId, config.id, from, to);
      for (const o of owed) {
        const prev = familyIncomeByMonth.get(o.monthKey) ?? Money.zero('BRL');
        familyIncomeByMonth.set(o.monthKey, prev.add(Money.fromNumber(o.owed, 'BRL')));
      }
    }

    const summaryService = new MonthSummaryService(this.db);
    return Promise.all(
      periods.map(async (p) => {
        const monthKey = `${p.year}-${String(p.month).padStart(2, '0')}`;
        const summary = await summaryService.getSummary(userId, p.month, p.year, {
          familyLoanIncomeOverride: familyIncomeByMonth.get(monthKey) ?? Money.zero('BRL'),
        });
        return {
          month: p.month,
          year: p.year,
          income: summary.totalIncome,
          expenses: summary.totalExpenses,
          balance: summary.balance,
        };
      }),
    );
  }
}
