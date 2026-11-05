import type { DbExecutor } from '@fc/db';
import type { MonthCore } from '@fc/domain';
import { Money } from '@fc/domain';
import { addMonths } from '@fc/shared';
import { noOpGuard } from '../lib/materialization-guard.ts';
import { BillService } from './bill.service.ts';
import { ForecastContextService, type ForecastMonth } from './forecast-context.service.ts';
import { IncomeOccurrenceService } from './income-occurrence.service.ts';
import { MonthOverviewService } from './month-overview.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

/**
 * Produces the balance-aware base projection for the simulator: the real-cash
 * anchor (WalletCashService.totalCash) and per-month canonical buckets shaped as
 * `MonthCore[]` (lever buckets zeroed, events empty). The pure fold + lever
 * overlay live in `@fc/domain` (projection-balance.ts); this service only
 * supplies the DB-derived numbers. Reads only — never triggers materialization:
 * the only collaborator that could (MonthOverviewService -> BillService) is
 * constructed with `noOpGuard` in `currentMonthCore`, so a simulator run writes
 * nothing. The horizon is materialized on the /projection prefetch path instead.
 */
export class BalanceProjectionService {
  constructor(private db: DbExecutor) {}

  /** Real aggregated BRL cash at `asOf` (Carteiras anchor) as a 2dp money string. */
  async getAnchorCash(userId: string, asOf: Date = new Date()): Promise<string> {
    const { totalCash } = await new WalletCashService(this.db).getWalletCash(userId, asOf);
    return Money.fromNumber(totalCash, 'BRL').toDbString();
  }

  /**
   * One `MonthCore` per month of the horizon starting at `asOf`'s calendar month.
   * Every month uses the unpaid remainder so early settlements already in the
   * cash anchor are not counted again. Lever buckets are 0 and `events` empty — the lever overlay
   * is applied later by the pure engine.
   */
  async getBaselineCores(
    userId: string,
    opts: { horizon: number; asOf?: Date; forecast?: ForecastMonth[] },
  ): Promise<MonthCore[]> {
    const asOf = opts.asOf ?? new Date();
    const horizon = opts.horizon;
    // Upper bound is 37, not 36: the simulator (the ONLY caller) fetches
    // `horizon + 1` cores — index 0 is the current partial month, which it folds
    // into the opening balance and then drops — so a user-facing 36-month
    // projection requests an internal horizon of 37 here.
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 37) {
      throw new Error(`Invalid horizon ${horizon}: must be an integer in 1..37`);
    }
    const currentMonth = asOf.getMonth() + 1;
    const currentYear = asOf.getFullYear();

    const from = { month: currentMonth, year: currentYear };
    const forecast =
      opts.forecast ??
      (await new ForecastContextService(this.db).getMonths(userId, from, horizon, asOf));

    const summaryService = new MonthSummaryService(this.db);
    const cores: MonthCore[] = [];

    for (let i = 0; i < horizon; i++) {
      const { month: m, year: y } = addMonths(from, i);
      const familyRemaining = forecast[i].familyRemaining;

      if (i === 0) {
        cores.push(await this.currentMonthCore(userId, m, y, asOf, familyRemaining));
        continue;
      }

      const s = await summaryService.getSummary(userId, m, y, {
        familyLoanIncomeOverride: Money.fromNumber(familyRemaining, 'BRL'),
        unpaidOnly: true,
      });

      const cards = await this.cardsDueInMonth(userId, m, y, true);
      const expenses = Money.fromNumber(s.totalExpenses, 'BRL')
        .subtract(Money.fromNumber(s.creditCardExpenses, 'BRL'))
        .add(cards);
      cores.push({
        month: m,
        year: y,
        income: {
          base: s.income,
          familyLoan: s.familyLoanIncome,
          lever: 0,
          total: s.totalIncome,
        },
        expenses: {
          creditCard: cards.toNumber(),
          loan: s.loanExpenses,
          charge: s.chargeExpenses,
          other: s.otherExpenses,
          lever: 0,
          total: expenses.toNumber(),
        },
        net: Money.fromNumber(s.totalIncome, 'BRL').subtract(expenses).toNumber(),
        events: [],
      });
    }

    return cores;
  }

  private async cardsDueInMonth(userId: string, month: number, year: number, unpaidOnly: boolean) {
    // Undated obligations stay in their closing month until a date is confirmed.
    const bills = await new BillService(this.db, noOpGuard).getBillsDueInMonth(
      userId,
      month,
      year,
      true,
    );
    return Money.sum(
      bills.map((bill) => Money.fromNumber(unpaidOnly ? bill.unpaidTotal : bill.total, 'BRL')),
      'BRL',
    );
  }

  /**
   * Current-month core using the UNPAID remainder so paid cash already baked into
   * the anchor is not double-counted. Unpaid expenses come from
   * `MonthOverviewService.toPay` (cards by fatura paid/unpaid split; loans/charges
   * by `(domainType,isPaid)`); unpaid income comes from FX-converted income
   * occurrences with `isPaid === false`. Family receipts use the canonical oldest-first ledger remainder;
   * amounts already allocated never enter expected cash again.
   */
  private async currentMonthCore(
    userId: string,
    month: number,
    year: number,
    asOf: Date,
    familyRemaining: number,
  ): Promise<MonthCore> {
    // noOpGuard: this is a pure read for the simulator. The horizon is
    // materialized on the /projection prefetch path (projection.router
    // get12Months), so the simulator read never triggers materializer writes.
    const overview = await new MonthOverviewService(this.db, noOpGuard).getOverview(
      userId,
      month,
      year,
      45,
      asOf,
    );
    const cards = await this.cardsDueInMonth(userId, month, year, true);
    const loan = Money.fromNumber(overview.toPay.loans, 'BRL');
    const charge = Money.fromNumber(overview.toPay.charges, 'BRL');
    const expenseTotal = cards.add(loan).add(charge);

    const incomeBrl = await this.unpaidIncomeForMonth(userId, month, year);

    const incomeTotal = incomeBrl.add(Money.fromNumber(familyRemaining, 'BRL'));
    const net = incomeTotal.subtract(expenseTotal);

    return {
      month,
      year,
      income: {
        base: incomeBrl.toNumber(),
        familyLoan: familyRemaining,
        lever: 0,
        total: incomeTotal.toNumber(),
      },
      expenses: {
        creditCard: cards.toNumber(),
        loan: loan.toNumber(),
        charge: charge.toNumber(),
        other: 0,
        lever: 0,
        total: expenseTotal.toNumber(),
      },
      net: net.toNumber(),
      events: [],
    };
  }

  /**
   * Unpaid (not-yet-received) income for the month, FX→BRL. Mirrors
   * MonthOverviewService.collectIncomeEvents: skip `isPaid` occurrences (already
   * in the anchor), prefer the per-tx rate then the config rate; a non-BRL row
   * with neither rate is SKIPPED (never assumed 1:1).
   */
  private async unpaidIncomeForMonth(userId: string, month: number, year: number): Promise<Money> {
    const sources = await new IncomeOccurrenceService(this.db).getOccurrences(userId, month, year);
    let accum = Money.zero('BRL');
    for (const source of sources) {
      for (const occ of source.occurrences) {
        if (occ.isPaid && occ.settlementSource !== 'date_assumed') continue;
        if (occ.amountBrl === null) continue;
        const brl = Money.fromString(occ.amountBrl, 'BRL');
        accum = accum.add(brl);
      }
    }
    return accum;
  }
}
