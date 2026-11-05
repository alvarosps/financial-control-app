import type { DbExecutor } from '@fc/db';
import { Money } from '@fc/domain';
import { localDayWindow, monthsInLocalWindow, parseIsoDate } from '../lib/calendar-dates.ts';
import type { MaterializationGuardLike } from '../lib/materialization-guard.ts';
import { DashboardService, type UpcomingItem } from './dashboard.service.ts';
import { FinancialObligationsService } from './financial-obligations.service.ts';
import { IncomeOccurrenceService } from './income-occurrence.service.ts';
import { MaterializationGuard } from './materialization-guard.service.ts';
import { type WalletCashOverview, WalletCashService } from './wallet-cash.service.ts';

export type MonthOverviewBucket = {
  cards: number;
  loans: number;
  charges: number;
  total: number;
};

export type PayPeriod = {
  /** YYYY-MM-DD; null for the leading "before first income" bucket. */
  incomeDate: string | null;
  incomeName: string | null;
  incomeTotal: number;
  bills: Array<{
    kind: 'card' | 'loan' | 'fixed_charge' | 'one_time_charge';
    id: string;
    name: string;
    dueDate: string;
    amount: number;
  }>;
  billsTotal: number;
  /** incomeTotal − billsTotal */
  saldoDoPeriodo: number;
  /** previous period's saldoCorrente + saldoDoPeriodo; the running value STARTS at cashToday */
  saldoCorrente: number;
};

export type MonthOverview = {
  paid: MonthOverviewBucket;
  toPay: MonthOverviewBucket;
  /**
   * Canonical real cash across BRL transaction wallets at asOf — opening balance
   * plus paid, non-reversed, post-anchor movements (via WalletCashService). The
   * SAME figure as the Carteiras screen; unpaid/future rows do NOT count. May be
   * negative. `cashToday` equals this value.
   */
  walletBalance: number;
  /** Identical to `walletBalance` (the anchored real cash at asOf). May be negative. */
  cashToday: number;
  cashQuality?: WalletCashOverview['wallets'];
  payrollDateUncertain?: boolean;
  periods: PayPeriod[];
};

/** A single income point in time on the planner timeline (BRL-converted). */
type IncomeEvent = {
  date: string; // YYYY-MM-DD
  name: string;
  amount: Money; // BRL
};

/**
 * Backs the dashboard "Fechamento do Mês" card: paid vs to-pay this calendar
 * month (split by source), the wallet balance, the cash actually settled so far,
 * and a pay-period planner that segments the upcoming window by income dates.
 *
 * Every query is scoped to `userId`, alongside runtime RLS.
 * All money math flows through `Money`; only the return boundary serializes to
 * `number`.
 */
export class MonthOverviewService {
  private dashboardService: DashboardService;
  private incomeOccurrenceService: IncomeOccurrenceService;

  /**
   * `guard` defaults to a real `MaterializationGuard` (the dashboard path keeps
   * its read-time materialization). Read-only callers — e.g. the simulator's
   * `BalanceProjectionService` — pass `noOpGuard` so the projection read never
   * triggers materializer writes (the read-causes-write bug that fired on
   * `refetchOnWindowFocus`).
   */
  constructor(
    private db: DbExecutor,
    private guard: MaterializationGuardLike = new MaterializationGuard(db),
  ) {
    this.dashboardService = new DashboardService(db, guard);
    this.incomeOccurrenceService = new IncomeOccurrenceService(db);
  }

  async getOverview(
    userId: string,
    month: number,
    year: number,
    horizonDays = 45,
    asOf: Date = new Date(),
  ): Promise<MonthOverview> {
    const { paid, toPay } = await this.computePaidToPay(userId, month, year);
    const { totalCash, wallets } = await new WalletCashService(this.db).getWalletCash(userId, asOf);
    const walletBalance = Money.fromNumber(totalCash, 'BRL');
    const cashToday = walletBalance;
    const { periods, payrollDateUncertain } = await this.computePeriods(
      userId,
      horizonDays,
      asOf,
      cashToday,
    );

    return {
      paid: {
        cards: paid.cards.toNumber(),
        loans: paid.loans.toNumber(),
        charges: paid.charges.toNumber(),
        total: paid.cards.add(paid.loans).add(paid.charges).toNumber(),
      },
      toPay: {
        cards: toPay.cards.toNumber(),
        loans: toPay.loans.toNumber(),
        charges: toPay.charges.toNumber(),
        total: toPay.cards.add(toPay.loans).add(toPay.charges).toNumber(),
      },
      walletBalance: walletBalance.toNumber(),
      cashToday: cashToday.toNumber(),
      cashQuality: wallets,
      payrollDateUncertain,
      periods,
    };
  }

  /**
   * Paid vs to-pay this calendar month, split by source. Cards are read by
   * due month via the shared obligations view; loans and
   * charges are read by transaction date within the UTC month window — matching
   * MonthSummaryService's boundary construction.
   */
  private async computePaidToPay(
    userId: string,
    month: number,
    year: number,
  ): Promise<{
    paid: { cards: Money; loans: Money; charges: Money };
    toPay: { cards: Money; loans: Money; charges: Money };
  }> {
    const result = await new FinancialObligationsService(this.db, this.guard).listForDuePeriod(
      userId,
      month,
      year,
    );
    const paid = { cards: Money.zero('BRL'), loans: Money.zero('BRL'), charges: Money.zero('BRL') };
    const toPay = {
      cards: Money.zero('BRL'),
      loans: Money.zero('BRL'),
      charges: Money.zero('BRL'),
    };
    for (const item of result.items) {
      if (item.direction !== 'payable') continue;
      const bucket =
        item.ref.kind === 'card_bill'
          ? 'cards'
          : item.ref.kind === 'loan_installment'
            ? 'loans'
            : item.ref.kind === 'charge'
              ? 'charges'
              : null;
      if (!bucket) continue;
      paid[bucket] = paid[bucket].add(Money.fromString(item.settledAmount, 'BRL'));
      if (item.status === 'open' || item.status === 'partial')
        toPay[bucket] = toPay[bucket].add(Money.fromString(item.remaining, 'BRL'));
    }
    return { paid, toPay };
  }

  /**
   * Pay-period planner: segments [asOf, asOf+horizonDays] by income dates. Each
   * income event opens a period; bills are bucketed under the LATEST income whose
   * date <= the bill's due date. Bills with no preceding income land in a leading
   * null bucket. saldoCorrente runs from `cashToday`.
   */
  private async computePeriods(
    userId: string,
    horizonDays: number,
    asOf: Date,
    cashToday: Money,
  ): Promise<{ periods: PayPeriod[]; payrollDateUncertain: boolean }> {
    // Family-loan receivables are intentionally NOT projected as income here:
    // family-loan payments are partial and recorded on their own dates (they flow
    // into cashToday as they settle). Projecting the open `remaining` as a single
    // receipt on the person's receiptDay misrepresented it as one lump-sum payment.
    const { events: incomeEvents, payrollDateUncertain } = await this.collectIncomeEvents(
      userId,
      horizonDays,
      asOf,
    );
    const bills = await this.collectBills(userId, horizonDays, asOf);

    // Sort income events ascending by date (stable on ties).
    incomeEvents.sort((a, b) => a.date.localeCompare(b.date));

    // Bucket each bill under the latest income event whose date <= bill.dueDate.
    const leadingBills: UpcomingItem[] = [];
    const billsByEventIndex = new Map<number, UpcomingItem[]>();
    for (const bill of bills) {
      let targetIndex = -1;
      for (let i = 0; i < incomeEvents.length; i++) {
        if (incomeEvents[i].date <= bill.dueDate) targetIndex = i;
        else break;
      }
      if (targetIndex === -1) {
        leadingBills.push(bill);
      } else {
        const arr = billsByEventIndex.get(targetIndex) ?? [];
        arr.push(bill);
        billsByEventIndex.set(targetIndex, arr);
      }
    }

    const toBillRow = (bill: UpcomingItem) => ({
      kind: bill.kind,
      id: bill.id,
      name: bill.name,
      dueDate: bill.dueDate,
      amount: bill.amount,
    });

    const periods: PayPeriod[] = [];
    let running = cashToday;

    // Leading bucket first — only when it actually has bills.
    if (leadingBills.length > 0) {
      const billsTotal = Money.sum(
        leadingBills.map((b) => Money.fromNumber(b.amount, 'BRL')),
        'BRL',
      );
      const incomeTotal = Money.zero('BRL');
      const saldoDoPeriodo = incomeTotal.subtract(billsTotal);
      running = running.add(saldoDoPeriodo);
      periods.push({
        incomeDate: null,
        incomeName: null,
        incomeTotal: 0,
        bills: leadingBills.map(toBillRow),
        billsTotal: billsTotal.toNumber(),
        saldoDoPeriodo: saldoDoPeriodo.toNumber(),
        saldoCorrente: running.toNumber(),
      });
    }

    // One period per income event, in ascending date order.
    for (let i = 0; i < incomeEvents.length; i++) {
      const event = incomeEvents[i];
      const periodBills = billsByEventIndex.get(i) ?? [];
      const billsTotal = Money.sum(
        periodBills.map((b) => Money.fromNumber(b.amount, 'BRL')),
        'BRL',
      );
      const saldoDoPeriodo = event.amount.subtract(billsTotal);
      running = running.add(saldoDoPeriodo);
      periods.push({
        incomeDate: event.date,
        incomeName: event.name,
        incomeTotal: event.amount.toNumber(),
        bills: periodBills.map(toBillRow),
        billsTotal: billsTotal.toNumber(),
        saldoDoPeriodo: saldoDoPeriodo.toNumber(),
        saldoCorrente: running.toNumber(),
      });
    }

    return { periods, payrollDateUncertain };
  }

  /**
   * BRL-converted FUTURE income events within [asOf(local day start),
   * asOf+horizonDays]. Loads income occurrences for EVERY calendar month the
   * planner window spans (not just current+next), flattens, drops occurrences
   * outside the window, keeps only NOT-YET-RECEIVED income (received income is
   * already reflected in cashToday/walletBalance), converts non-BRL via the
   * per-tx then config rate (same rule as MonthSummaryService), then groups
   * same-date occurrences into a single event. A shared date with multiple
   * sources is labelled with the joined names, or "Entradas" beyond two.
   */
  private async collectIncomeEvents(
    userId: string,
    horizonDays: number,
    asOf: Date,
  ): Promise<{ events: IncomeEvent[]; payrollDateUncertain: boolean }> {
    const { inWindow } = localDayWindow(asOf, horizonDays);

    const months = monthsInLocalWindow(asOf, horizonDays);
    const sources = (
      await Promise.all(
        months.map((p) => this.incomeOccurrenceService.getOccurrences(userId, p.month, p.year)),
      )
    ).flat();

    // date(YYYY-MM-DD) → { amount: Money(BRL), names: string[] }
    const byDate = new Map<string, { amount: Money; names: string[] }>();

    for (const source of sources) {
      for (const occ of source.occurrences) {
        // The planner projects FUTURE income only: an already-received (isPaid)
        // occurrence is already counted in cashToday, so re-emitting it here
        // would double-count it on the running saldoCorrente.
        if (
          (occ.isPaid && occ.settlementSource !== 'date_assumed') ||
          occ.needsPayrollAllocation ||
          occ.amountBrl === null
        )
          continue;
        const due = parseIsoDate(occ.date);
        if (!inWindow(due)) continue;
        const brl = Money.fromString(occ.amountBrl, 'BRL');
        const slot = byDate.get(occ.date) ?? { amount: Money.zero('BRL'), names: [] };
        slot.amount = slot.amount.add(brl);
        slot.names.push(source.name);
        byDate.set(occ.date, slot);
      }
    }

    const events: IncomeEvent[] = [];
    for (const [date, slot] of byDate) {
      const uniqueNames = [...new Set(slot.names)];
      const name =
        uniqueNames.length === 1
          ? uniqueNames[0]
          : uniqueNames.length === 2
            ? uniqueNames.join(' + ')
            : 'Entradas';
      events.push({ date, name, amount: slot.amount });
    }
    return {
      events,
      payrollDateUncertain: sources.some((source) => source.needsPayrollAllocation),
    };
  }

  /** Unpaid upcoming bills within the window (cards, loans, charges). */
  private async collectBills(
    userId: string,
    horizonDays: number,
    asOf: Date,
  ): Promise<UpcomingItem[]> {
    // getUpcomingItems already constrains items to [asOf, asOf+horizonDays] using
    // the same asOf and local-day window/parser, so we only filter out the
    // already-paid ones here — re-checking the window would be redundant.
    const items = await this.dashboardService.getUpcomingItems(userId, horizonDays, asOf);
    return items.filter((item) => !item.isPaid);
  }
}
