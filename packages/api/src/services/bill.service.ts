import type { DbExecutor } from '@fc/db';
import { accounts, creditCardBills, creditCardConfigs, transactions } from '@fc/db';
import type { StatementCycle } from '@fc/domain';
import { BusinessRuleError, type DomainType, InvariantViolationError, Money } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { startOfMonth, subMonths } from 'date-fns';
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { acquireBillLock } from '../lib/bill-lock.ts';
import { loadEffectiveCardConfigs } from '../lib/card-group.ts';
import { createCardWriteContext } from '../lib/card-write-context.ts';
import { computeCardBillTotals } from '../lib/credit-card-totals.ts';
import { errorCause } from '../lib/error-codes.ts';
import type { MaterializationGuardLike } from '../lib/materialization-guard.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { isUniqueViolation } from '../lib/pg-errors.ts';
import { AccountService } from './account.service.ts';
import { AuditService } from './audit.service.ts';
import { CreditCardLifecycleService } from './credit-card-lifecycle.service.ts';
import { SettlementService } from './settlement.service.ts';
import { StatementCycleService, statementKey } from './statement-cycle.service.ts';
import { TransactionService } from './transaction.service.ts';

export class BillService {
  private accountService: AccountService;
  private auditService: AuditService;

  constructor(
    private db: DbExecutor,
    private guard: MaterializationGuardLike,
  ) {
    this.accountService = new AccountService(db);
    this.auditService = new AuditService(db);
  }

  /**
   * Splits bill items into charges and refunds (`domain_type = 'credit_card_refund'`)
   * and computes net totals. A refund is a CREDIT: it lowers the amount owed and is
   * never itself "paid". Shared by getBill and the pay-bill flow so the displayed
   * total, the amount charged when paying, and the paid-state all agree. Mirrors
   * the frontend BillComposition (`grandTotal = … − refunds`) and
   * projection.service (`creditCard = ccGross − ccRefund`).
   */
  static computeBillTotals<
    T extends { amount: string; isPaid: boolean; domainType: string | null },
  >(items: T[], currency: string) {
    return computeCardBillTotals(items, currency);
  }

  async getBill(userId: string, cardAccountId: string, month: number, year: number) {
    await this.guard.ensureMaterialized(userId, month, year);
    await this.accountService.getById(userId, cardAccountId);

    const cycleService = new StatementCycleService(this.db);
    const ref = { cardAccountId, month, year };
    const cycle = (await cycleService.resolveMany(userId, [ref])).get(statementKey(ref));
    if (!cycle) throw new InvariantViolationError('Statement cycle not resolved');
    const config = (await loadEffectiveCardConfigs(this.db, userId, [cardAccountId])).get(
      cardAccountId,
    );

    const billTransactions = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.destinationAccountId, cardAccountId),
          eq(transactions.billingMonth, month),
          eq(transactions.billingYear, year),
          eq(transactions.isReversed, false),
        ),
      );

    // Exclude bill_payment transfers from the bill items
    const billItems = billTransactions.filter((tx) => tx.domainType !== 'bill_payment');

    const currency = this.resolveCurrency(billItems);
    const { totalMoney, paidTotalMoney, unpaidTotalMoney, isPaid } = BillService.computeBillTotals(
      billItems,
      currency,
    );

    return {
      cardAccountId,
      month,
      year,
      // Money instances (authoritative). Prefer these in server-side code.
      totalMoney,
      paidTotalMoney,
      unpaidTotalMoney,
      /** @deprecated Use totalMoney; kept for legacy numeric consumers. */
      total: totalMoney.toNumber(),
      /** @deprecated Use paidTotalMoney; kept for legacy numeric consumers. */
      paidTotal: paidTotalMoney.toNumber(),
      /** @deprecated Use unpaidTotalMoney; kept for legacy numeric consumers. */
      unpaidTotal: unpaidTotalMoney.toNumber(),
      transactionCount: billItems.length,
      transactions: billItems,
      isPaid,
      dueDay: config?.dueDay ?? null,
      ...cycle,
      statementId: statementKey(ref),
    };
  }

  async getConsolidatedBill(
    userId: string,
    parentCardAccountId: string,
    month: number,
    year: number,
  ) {
    await this.guard.ensureMaterialized(userId, month, year);
    await this.accountService.getById(userId, parentCardAccountId);

    // Parent + active children (additional cards) with display metadata.
    const cards = await this.db
      .select({
        id: accounts.id,
        name: accounts.name,
        color: accounts.color,
        parentAccountId: accounts.parentAccountId,
        isActive: accounts.isActive,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
          or(
            eq(accounts.id, parentCardAccountId),
            eq(accounts.parentAccountId, parentCardAccountId),
          ),
        ),
      );

    const cardIds = cards.map((c) => c.id);

    const rows = cardIds.length
      ? await this.db
          .select({
            cardId: transactions.destinationAccountId,
            amount: transactions.amount,
            isPaid: transactions.isPaid,
            domainType: transactions.domainType,
            currency: transactions.currency,
          })
          .from(transactions)
          .where(
            and(
              eq(transactions.userId, userId),
              inArray(transactions.destinationAccountId, cardIds),
              eq(transactions.billingMonth, month),
              eq(transactions.billingYear, year),
              eq(transactions.isReversed, false),
              or(ne(transactions.domainType, 'bill_payment'), isNull(transactions.domainType)),
            ),
          )
      : [];

    // Single authoritative currency for the consolidated bill; raises the
    // mixed-currency invariant rather than silently summing under an arbitrary
    // one. Empty rows → 'BRL' (a zero-item bill trivially totals 0). Same helper
    // getBill uses.
    const currency = this.resolveCurrency(rows);

    type Row = { amount: string; isPaid: boolean; domainType: string | null };
    const itemsByCard = new Map<string, Row[]>();
    for (const r of rows) {
      if (r.cardId == null) continue;
      const arr = itemsByCard.get(r.cardId) ?? [];
      arr.push({ amount: r.amount, isPaid: r.isPaid, domainType: r.domainType });
      itemsByCard.set(r.cardId, arr);
    }

    let unpaidTotalMoney = Money.zero(currency);
    const principalIsActive = cards.find((card) => card.id === parentCardAccountId)?.isActive;
    const breakdown = cards.map((card) => {
      const items = itemsByCard.get(card.id) ?? [];
      const { totalMoney, unpaidTotalMoney: pending } = BillService.computeBillTotals(
        items,
        currency,
      );
      const payable =
        principalIsActive && card.isActive && pending.isPositive() ? pending : Money.zero(currency);
      unpaidTotalMoney = unpaidTotalMoney.add(payable);
      return {
        cardId: card.id,
        name: card.name,
        color: card.color,
        total: totalMoney.toNumber(),
        unpaidTotal: payable.toNumber(),
        isPrincipal: card.parentAccountId == null,
      };
    });

    // Principal first, then children sorted by total descending.
    breakdown.sort((a, b) => {
      if (a.isPrincipal !== b.isPrincipal) return a.isPrincipal ? -1 : 1;
      return b.total - a.total;
    });

    const total = breakdown.reduce((sum, b) => sum + b.total, 0);

    // Consolidated paid-state + item count across parent + children, on the
    // combined set (mirrors getBill's per-card semantics): the consolidated
    // fatura is "paid" once every charge across all cards is paid. Feeds the
    // detail-page side panel so it reflects the fatura actually being paid.
    const combinedItems = rows.map((r) => ({
      amount: r.amount,
      isPaid: r.isPaid,
      domainType: r.domainType,
    }));
    const { isPaid } = BillService.computeBillTotals(combinedItems, currency);

    return {
      total,
      unpaidTotal: unpaidTotalMoney.toNumber(),
      currency,
      isPaid,
      transactionCount: combinedItems.length,
      breakdown,
    };
  }

  private advanceMonth(month: number, year: number) {
    return month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };
  }

  private retreatMonth(month: number, year: number) {
    return month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
  }

  /**
   * Shared consolidation core for fatura summaries. Given the periods we need,
   * runs ONE aggregated transaction query across every active card (parents +
   * children) and returns:
   *  - `parentCards`: the principal cards to emit (children fold into them).
   *  - `lookupConsolidated(parentId, month, year)`: parent + all its children
   *    netted (refunds subtracted, bill_payment excluded, reversed excluded),
   *    with the all-paid roll-up.
   *  - `dueDayByCard`: per-card due day from creditCardConfigs.
   *
   * Both `getBillSummary` (4-period window) and `getBillForMonth` (single
   * period) consume this so the refund-netting / parent-child folding math
   * lives in exactly one place.
   */
  private async buildConsolidatedLookup(
    userId: string,
    periodKeys: Array<{ month: number; year: number }>,
  ): Promise<{
    parentCards: Array<typeof accounts.$inferSelect>;
    lookupConsolidated: (
      parentId: string,
      month: number,
      year: number,
    ) => {
      total: number;
      paidTotal: number;
      unpaidTotal: number;
      transactionCount: number;
      isPaid: boolean;
    };
    dueDayByCard: Map<string, number | null>;
    closingDayByCard: Map<string, number | null>;
  }> {
    const allCardAccounts = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
          eq(accounts.isActive, true),
        ),
      );

    // `paidTotal` is the already-paid portion of CHARGES (refunds are credits,
    // never "paid"); `unpaidTotal = total − paidTotal` is what still must be
    // settled. Both are net-of-refund so the dashboard's paid/to-pay split lines
    // up with the displayed fatura total.
    type Agg = {
      total: number;
      paidTotal: number;
      unpaidTotal: number;
      transactionCount: number;
      isPaid: boolean;
    };
    const emptyAgg: Agg = {
      total: 0,
      paidTotal: 0,
      unpaidTotal: 0,
      transactionCount: 0,
      isPaid: false,
    };

    if (allCardAccounts.length === 0) {
      return {
        parentCards: [],
        lookupConsolidated: () => emptyAgg,
        dueDayByCard: new Map(),
        closingDayByCard: new Map(),
      };
    }

    const parentCards = allCardAccounts.filter((c) => c.parentAccountId == null);
    // Reuse the shared helper (Task A1) so parent→children logic lives in one place.
    const childrenByParent = await this.accountService.getCreditCardChildrenMap(userId);
    // Query transactions for ALL cards (parents + children) so we can roll up.
    const cardIds = allCardAccounts.map((c) => c.id);

    // Single aggregated query across all cards and all relevant periods.
    // Excludes bill_payment (kept consistent with getBill's filter) and reversed
    // transactions. Groups by (card, billingMonth, billingYear) to produce one
    // row per (card, period) we actually need in memory.
    const rows = await this.db
      .select({
        cardId: transactions.destinationAccountId,
        billingMonth: transactions.billingMonth,
        billingYear: transactions.billingYear,
        // credit_card_refund rows are credits: subtract them from the total and
        // treat them as "paid" for the all-paid roll-up (they are never payable).
        total: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.domainType} = 'credit_card_refund' THEN -${transactions.amount} ELSE ${transactions.amount} END), 0)`,
        paidTotal: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.isPaid} AND ${transactions.domainType} IS DISTINCT FROM 'credit_card_refund' THEN ${transactions.amount} ELSE 0 END), 0)`,
        txCount: sql<number>`COUNT(*)::int`,
        allPaid: sql<boolean>`COALESCE(BOOL_AND(CASE WHEN ${transactions.domainType} = 'credit_card_refund' THEN true ELSE ${transactions.isPaid} END), false)`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isReversed, false),
          inArray(transactions.destinationAccountId, cardIds),
          or(ne(transactions.domainType, 'bill_payment'), sql`${transactions.domainType} IS NULL`),
          or(
            ...periodKeys.map((p) =>
              and(eq(transactions.billingMonth, p.month), eq(transactions.billingYear, p.year)),
            ),
          ),
        ),
      )
      .groupBy(
        transactions.destinationAccountId,
        transactions.billingMonth,
        transactions.billingYear,
      );

    // Index aggregates by `${cardId}|${month}|${year}` for O(1) lookup.
    const aggMap = new Map<string, Agg>();
    for (const r of rows) {
      if (r.billingMonth == null || r.billingYear == null) continue;
      const key = `${r.cardId}|${r.billingMonth}|${r.billingYear}`;
      const total = Number(r.total);
      const paidTotal = Number(r.paidTotal);
      aggMap.set(key, {
        total,
        paidTotal,
        // Net of refunds, so paying the unpaid portion settles the fatura. A
        // net-credit fatura (refunds > charges) clamps to 0 — never negative.
        unpaidTotal: Math.max(total - paidTotal, 0),
        transactionCount: r.txCount,
        isPaid: r.txCount > 0 && r.allPaid,
      });
    }

    const lookup = (cardId: string, m: number, y: number): Agg =>
      aggMap.get(`${cardId}|${m}|${y}`) ?? emptyAgg;

    // Consolidated aggregate for a parent = parent + all its children.
    const lookupConsolidated = (parentId: string, mo: number, yr: number): Agg => {
      const ids = [parentId, ...(childrenByParent.get(parentId) ?? [])];
      let total = 0;
      let paidTotal = 0;
      let unpaidTotal = 0;
      let transactionCount = 0;
      let anyTx = false;
      let anyUnpaidNonEmpty = false;
      for (const id of ids) {
        const a = lookup(id, mo, yr);
        total += a.total;
        paidTotal += a.paidTotal;
        unpaidTotal += a.unpaidTotal;
        transactionCount += a.transactionCount;
        if (a.transactionCount > 0) {
          anyTx = true;
          if (!a.isPaid) anyUnpaidNonEmpty = true;
        }
      }
      return {
        total,
        paidTotal,
        unpaidTotal,
        transactionCount,
        isPaid: anyTx && !anyUnpaidNonEmpty,
      };
    };

    // Due/closing days per card — single query. closingDay is needed alongside
    // dueDay to compute the real-calendar fatura due date (see
    // computeFaturaDueDate): when dueDay <= closingDay the fatura is due the
    // month AFTER its billingMonth.
    const configs = await this.db
      .select({
        accountId: creditCardConfigs.accountId,
        dueDay: creditCardConfigs.dueDay,
        closingDay: creditCardConfigs.closingDay,
      })
      .from(creditCardConfigs)
      .where(inArray(creditCardConfigs.accountId, cardIds));
    const dueDayByCard = new Map<string, number | null>();
    const closingDayByCard = new Map<string, number | null>();
    for (const c of configs) {
      dueDayByCard.set(c.accountId, c.dueDay);
      closingDayByCard.set(c.accountId, c.closingDay);
    }

    return { parentCards, lookupConsolidated, dueDayByCard, closingDayByCard };
  }

  /**
   * Per-card consolidated fatura for ONE arbitrary (month, year). Mirrors the
   * `currentBill` shape getBillSummary produces, but for an explicit period
   * instead of the current calendar month — so callers (e.g. the dashboard's
   * upcoming-items window) can fetch a fatura that falls in a future month.
   * Net of refunds, bill_payment excluded, parent/child folded — exactly like
   * getBillSummary, via the shared `buildConsolidatedLookup`.
   */
  async getBillForMonth(
    userId: string,
    month: number,
    year: number,
  ): Promise<
    Array<{
      cardId: string;
      cardName: string;
      dueDay: number | null;
      dueDate: string | null;
      closingDate: string | null;
      dueDateSource: StatementCycle['dueDateSource'];
      billId: string | null;
      statementId: string;
      total: number;
      /** Already-paid portion of the fatura (net of refunds). */
      paidTotal: number;
      /** Still-owed portion (= total − paidTotal, clamped at 0). */
      unpaidTotal: number;
      isPaid: boolean;
      month: number;
      year: number;
    }>
  > {
    await this.guard.ensureMaterialized(userId, month, year);

    const { parentCards, lookupConsolidated, dueDayByCard } = await this.buildConsolidatedLookup(
      userId,
      [{ month, year }],
    );

    const cycles = await new StatementCycleService(this.db).resolveMany(
      userId,
      parentCards.map((card) => ({ cardAccountId: card.id, month, year })),
    );
    return parentCards.map((card) => {
      const agg = lookupConsolidated(card.id, month, year);
      const dueDay = dueDayByCard.get(card.id) ?? null;
      const statementId = statementKey({ cardAccountId: card.id, month, year });
      const cycle = cycles.get(statementId);
      return {
        cardId: card.id,
        cardName: card.name,
        dueDay,
        dueDate: cycle?.dueDate ?? null,
        closingDate: cycle?.closingDate ?? null,
        dueDateSource: cycle?.dueDateSource ?? 'unknown',
        billId: cycle?.billId ?? null,
        statementId,
        total: agg.total,
        paidTotal: agg.paidTotal,
        unpaidTotal: agg.unpaidTotal,
        isPaid: agg.isPaid,
        month,
        year,
      };
    });
  }

  async getBillsDueInMonth(userId: string, month: number, year: number, includeUndated = false) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const next = this.advanceMonth(month, year);
    const persisted = await this.db
      .select({ month: creditCardBills.month, year: creditCardBills.year })
      .from(creditCardBills)
      .innerJoin(accounts, eq(accounts.id, creditCardBills.creditCardAccountId))
      .where(
        and(
          eq(accounts.userId, userId),
          gte(creditCardBills.dueDate, `${prefix}-01`),
          lt(creditCardBills.dueDate, `${next.year}-${String(next.month).padStart(2, '0')}-01`),
        ),
      );
    const periods = new Map(
      [{ month, year }, this.retreatMonth(month, year), ...persisted].map((period) => [
        `${period.year}-${period.month}`,
        period,
      ]),
    );
    const result: Awaited<ReturnType<BillService['getBillForMonth']>> = [];
    for (const period of periods.values()) {
      const bills = await this.getBillForMonth(userId, period.month, period.year);
      result.push(
        ...bills.filter(
          (bill) =>
            bill.dueDate?.startsWith(`${prefix}-`) ||
            (includeUndated && bill.dueDate === null && bill.month === month && bill.year === year),
        ),
      );
    }
    return result;
  }

  async getBillSummary(userId: string) {
    const now = new Date();
    const calendarMonth = now.getMonth() + 1;
    const calendarYear = now.getFullYear();
    await this.guard.ensureMaterialized(userId, calendarMonth, calendarYear);

    const prev = this.retreatMonth(calendarMonth, calendarYear);
    const next = this.advanceMonth(calendarMonth, calendarYear);
    const nextNext = this.advanceMonth(next.month, next.year);
    const periodKeys: Array<{ month: number; year: number }> = [
      prev,
      { month: calendarMonth, year: calendarYear },
      next,
      nextNext,
    ];

    const { parentCards, lookupConsolidated, dueDayByCard } = await this.buildConsolidatedLookup(
      userId,
      periodKeys,
    );

    if (parentCards.length === 0) return [];
    const cycles = await new StatementCycleService(this.db).resolveMany(
      userId,
      parentCards.map((card) => ({
        cardAccountId: card.id,
        month: calendarMonth,
        year: calendarYear,
      })),
    );

    const lifecycle = new CreditCardLifecycleService(this.db, () => now);
    const eligibilityByCardId = await lifecycle.getArchiveEligibilityForGroups(
      userId,
      parentCards.map((card) => ({
        rootId: card.id,
        currentBillTotal: lookupConsolidated(card.id, calendarMonth, calendarYear).total,
      })),
    );

    return parentCards.map((card) => {
      const current = lookupConsolidated(card.id, calendarMonth, calendarYear);
      const eligibility = eligibilityByCardId.get(card.id) ?? {
        canArchive: false,
        blockedReason: 'FUTURE_COMMITMENTS' as const,
      };

      // Always show the CURRENT calendar-month bill on the list page — never
      // advance to the next month. A paid current bill stays visible (as paid);
      // the next month is surfaced separately via `nextBillPreview`.
      const activeMonth = calendarMonth;
      const activeYear = calendarYear;
      const active = current;

      const nextPeriod = this.advanceMonth(activeMonth, activeYear);
      const nextPreview = lookupConsolidated(card.id, nextPeriod.month, nextPeriod.year);

      const prevPeriod = this.retreatMonth(activeMonth, activeYear);
      const prevAgg = lookupConsolidated(card.id, prevPeriod.month, prevPeriod.year);

      const dueDay = dueDayByCard.get(card.id) ?? null;
      const statementId = statementKey({
        cardAccountId: card.id,
        month: activeMonth,
        year: activeYear,
      });
      const cycle = cycles.get(statementId);

      return {
        cardId: card.id,
        cardName: card.name,
        color: card.color,
        canArchive: eligibility.canArchive,
        archiveBlockedReason: eligibility.blockedReason,
        currentBill: {
          month: activeMonth,
          year: activeYear,
          total: active.total,
          unpaidTotal: active.unpaidTotal,
          transactionCount: active.transactionCount,
          isPaid: active.isPaid,
          dueDay,
          dueDate: cycle?.dueDate ?? null,
          closingDate: cycle?.closingDate ?? null,
          dueDateSource: cycle?.dueDateSource ?? 'unknown',
          billId: cycle?.billId ?? null,
          statementId,
        },
        previousBill:
          prevAgg.transactionCount > 0
            ? {
                month: prevPeriod.month,
                year: prevPeriod.year,
                total: prevAgg.total,
                isPaid: prevAgg.isPaid,
              }
            : null,
        nextBillPreview: {
          month: nextPeriod.month,
          year: nextPeriod.year,
          total: nextPreview.total,
          transactionCount: nextPreview.transactionCount,
        },
      };
    });
  }

  async getBillHistory(userId: string, cardAccountId: string) {
    await this.accountService.getById(userId, cardAccountId);

    const end = startOfMonth(new Date());
    const start = subMonths(end, 11);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const startStr = fmt(start);
    const endStr = fmt(end);

    // Single config fetch for dueDay.
    const [config] = await this.db
      .select({ dueDay: creditCardConfigs.dueDay })
      .from(creditCardConfigs)
      .where(eq(creditCardConfigs.accountId, cardAccountId));
    const dueDay = config?.dueDay ?? null;

    // Single aggregated query across the 12-month window. Filter mirrors
    // getBill's in-memory filter: exclude reversed rows and bill_payment
    // transfers (including NULL domainType — matches Task 2's fix).
    // make_date(year, month, 1) BETWEEN start AND end covers the window
    // (both inclusive — `end` is the first day of the current month).
    // `db.execute<TRow>` types the rows directly from the hand-written SELECT.
    const rows = await this.db.execute<{
      month: number;
      year: number;
      total: string;
      paid_total: string;
      transaction_count: number;
      all_paid: boolean;
    }>(sql`
      SELECT
        ${transactions.billingMonth} AS month,
        ${transactions.billingYear} AS year,
        COALESCE(SUM(CASE WHEN ${transactions.domainType} = 'credit_card_refund' THEN -${transactions.amount}::numeric ELSE ${transactions.amount}::numeric END), 0) AS total,
        COALESCE(SUM(CASE WHEN ${transactions.isPaid} AND ${transactions.domainType} IS DISTINCT FROM 'credit_card_refund' THEN ${transactions.amount}::numeric ELSE 0 END), 0) AS paid_total,
        COUNT(*)::int AS transaction_count,
        COALESCE(BOOL_AND(CASE WHEN ${transactions.domainType} = 'credit_card_refund' THEN true ELSE ${transactions.isPaid} END), false) AS all_paid
      FROM ${transactions}
      WHERE ${transactions.destinationAccountId} = ${cardAccountId}
        AND ${transactions.userId} = ${userId}
        AND ${transactions.isReversed} = false
        AND (${transactions.domainType} <> 'bill_payment' OR ${transactions.domainType} IS NULL)
        AND ${transactions.billingMonth} IS NOT NULL
        AND ${transactions.billingYear} IS NOT NULL
        AND make_date(${transactions.billingYear}, ${transactions.billingMonth}, 1)
            BETWEEN ${startStr}::date AND ${endStr}::date
      GROUP BY ${transactions.billingMonth}, ${transactions.billingYear}
    `);

    const aggMap = new Map<
      string,
      { total: number; paidTotal: number; count: number; allPaid: boolean }
    >();
    for (const r of rows) {
      aggMap.set(`${r.month}|${r.year}`, {
        total: Number(r.total),
        paidTotal: Number(r.paid_total),
        count: r.transaction_count,
        allPaid: r.all_paid,
      });
    }

    const results: Array<{
      month: number;
      year: number;
      total: number;
      paidTotal: number;
      unpaidTotal: number;
      transactionCount: number;
      isPaid: boolean;
      dueDay: number | null;
    }> = [];

    for (let i = 11; i >= 0; i--) {
      const targetDate = subMonths(end, i);
      const month = targetDate.getMonth() + 1;
      const year = targetDate.getFullYear();
      const agg = aggMap.get(`${month}|${year}`);
      const total = agg?.total ?? 0;
      const paidTotal = agg?.paidTotal ?? 0;
      const count = agg?.count ?? 0;
      const allPaid = agg?.allPaid ?? false;
      results.push({
        month,
        year,
        total,
        paidTotal,
        unpaidTotal: total - paidTotal,
        transactionCount: count,
        isPaid: count > 0 && allPaid,
        dueDay,
      });
    }

    return results;
  }

  async payBill(
    userId: string,
    cardAccountId: string,
    month: number,
    year: number,
    paidFromAccountId: string,
    settlementDate?: Date,
    expectedAmount?: string,
  ) {
    await new CreditCardLifecycleService(this.db).assertActiveCard(userId, cardAccountId);
    // Ownership checks stay outside the tx — read-only fast-fail on 404. The
    // card row also tells us whether this is a principal (no parent), so we know
    // whether to fan out to its additional (child) cards.
    const card = await this.accountService.getById(userId, cardAccountId);
    await this.accountService.getById(userId, paidFromAccountId);

    // A principal settles its OWN fatura PLUS every active additional (child)
    // card in ONE transaction, so the consolidated fatura is paid together.
    // Paying a child card directly settles only that child.
    let targetIds = [cardAccountId];
    if (card.parentAccountId == null) {
      const childrenByParent = await this.accountService.getCreditCardChildrenMap(userId);
      targetIds = [cardAccountId, ...(childrenByParent.get(cardAccountId) ?? [])];
    }
    // Acquire the per-card advisory locks in a deterministic (sorted) order so
    // two concurrent payers never lock the same cards in opposite orders.
    const orderedIds = [...targetIds].sort();

    let result: {
      transferTransaction: unknown;
      billTotal: string;
      markedCount: number;
      paidCardCount: number;
      paidCards: Array<{ cardAccountId: string; amount: string }>;
    };
    try {
      result = await runWithMaterializationLock(this.db, userId, async ({ db: tx }) => {
        const [wallet] = await tx
          .select()
          .from(accounts)
          .where(and(eq(accounts.id, paidFromAccountId), eq(accounts.userId, userId)))
          .for('update');
        const settledAt = settlementDate ?? new Date();
        if (!Number.isFinite(settledAt.getTime()) || settledAt > new Date())
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid payment date' });
        if (expectedAmount !== undefined) {
          const bill = await new BillService(tx, this.guard).getConsolidatedBill(
            userId,
            cardAccountId,
            month,
            year,
          );
          if (Money.fromNumber(bill.unpaidTotal, 'BRL').toDbString() !== expectedAmount)
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Bill changed. Reload before recording payment.',
            });
        }
        if (
          !wallet?.isActive ||
          wallet.type !== 'checking' ||
          wallet.currency !== 'BRL' ||
          (wallet.openingBalanceAnchorAt && wallet.openingBalanceAnchorAt >= settledAt)
        ) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Bill payment requires an active BRL checking wallet with a prior cash anchor.',
            cause: errorCause('bill.invalidPaymentWallet'),
          });
        }
        const paid: Array<{
          id: string;
          transfer: unknown;
          unpaid: Money;
          markedCount: number;
          currency: string;
        }> = [];
        for (const id of orderedIds) {
          const r = await this.payCardWithinTx(
            tx,
            userId,
            id,
            month,
            year,
            paidFromAccountId,
            settledAt,
          );
          if (r.paid) {
            paid.push({
              id,
              transfer: r.transfer,
              unpaid: r.unpaid,
              markedCount: r.markedCount,
              currency: r.currency,
            });
          }
        }

        if (paid.length === 0) {
          // Nothing to pay on the principal NOR any child (all already paid,
          // empty, or net credit). Same i18n key as the concurrent-payment race,
          // since both end in "there is nothing to pay on this bill".
          throw new BusinessRuleError('Não há valor pendente nesta fatura', {
            cardAccountId,
            month,
            year,
            ...errorCause('bill.nothingToPay'),
          });
        }

        // A consolidated fatura cannot be summed across currencies without an FX
        // rate. Surface the SAME structured error getBill uses (mixedCurrency)
        // rather than letting Money.add throw a bare Error that maps to a
        // generic 500. (Unreachable today — additional cards are forced to BRL.)
        const payCurrencies = new Set(paid.map((p) => p.currency));
        if (payCurrencies.size > 1) {
          throw new InvariantViolationError(
            `Mixed currencies across cards paying fatura for ${cardAccountId} ${month}/${year}`,
            { currencies: [...payCurrencies], ...errorCause('bill.mixedCurrency') },
          );
        }

        // Total actually debited = sum of every card's unpaid portion.
        let totalMoney = paid[0].unpaid;
        for (let i = 1; i < paid.length; i++) {
          totalMoney = totalMoney.add(paid[i].unpaid);
        }
        const markedCount = paid.reduce((n, p) => n + p.markedCount, 0);
        // Prefer the principal's transfer as the representative return value.
        const representative = paid.find((p) => p.id === cardAccountId) ?? paid[0];
        return {
          transferTransaction: representative.transfer,
          billTotal: totalMoney.toDbString(),
          markedCount,
          paidCardCount: paid.length,
          // Per-card breakdown so the audit log attributes the settlement to
          // each card that was actually paid (not just the principal lump sum).
          paidCards: paid.map((p) => ({ cardAccountId: p.id, amount: p.unpaid.toDbString() })),
        };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'tx_bill_payment_unique')) {
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'Já existe um pagamento para este período de fatura. A divergência exige revisão antes de outro pagamento.',
          cause: errorCause('bill.alreadyPaid'),
        });
      }
      throw err;
    }

    await this.auditService.log(userId, 'pay', 'bill', cardAccountId, undefined, {
      month,
      year,
      paidAmount: result.billTotal,
      paidCardCount: result.paidCardCount,
      paidCards: result.paidCards,
    });

    return result;
  }

  /**
   * Settle ONE card's fatura inside an existing transaction. Returns a
   * discriminated result instead of throwing on "nothing to pay" so the cascade
   * can SKIP an already-settled / empty / net-credit child WITHOUT aborting the
   * whole tx (a thrown error would roll back every sibling payment too). Genuine
   * corruption (more paid than charged) still throws — that must abort.
   *
   * Ordering inside the tx is load-bearing:
   *  1. Acquire advisory xact lock — serializes concurrent payers for the same
   *     (user, card, month, year). Auto-released at COMMIT/ROLLBACK.
   *  2. Re-fetch billable transactions with SELECT ... FOR UPDATE — locks the
   *     rows we are about to update so concurrent mutators block. This closes
   *     the TOCTOU window: totals/paid-state come from a locked snapshot.
   *     `ne(domainType, 'bill_payment')` alone would evaluate to UNKNOWN for
   *     NULL rows and drop them; we explicitly OR in IS NULL so the locked set
   *     matches the JS-side filter `tx.domainType !== 'bill_payment'`.
   *  3. Create bill_payment transfer, mark items paid, upsert credit_card_bills.
   *
   * The skip decision ("nothing to pay") is derived purely from charge
   * paid-state, NOT from the existence of a bill_payment row — that row is
   * intentionally outside the locked snapshot. The partial unique index
   * `tx_bill_payment_unique` (one non-reversed bill_payment per card+period),
   * not the advisory lock, is the AUTHORITATIVE idempotency guard: a desynced /
   * out-of-band bill_payment makes the INSERT raise 23505, which payBill maps to
   * CONFLICT. In a multi-card cascade that aborts the whole tx (no partial
   * payment) — acceptable, since it only happens on a genuine desync.
   */
  private async payCardWithinTx(
    tx: DbExecutor,
    userId: string,
    cardAccountId: string,
    month: number,
    year: number,
    paidFromAccountId: string,
    settledAt: Date,
  ): Promise<
    | { paid: true; transfer: unknown; unpaid: Money; markedCount: number; currency: string }
    | { paid: false }
  > {
    await acquireBillLock(tx, userId, cardAccountId, month, year);

    const items = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.destinationAccountId, cardAccountId),
          eq(transactions.billingMonth, month),
          eq(transactions.billingYear, year),
          eq(transactions.isReversed, false),
          or(ne(transactions.domainType, 'bill_payment'), isNull(transactions.domainType)),
        ),
      )
      .for('update');

    const currency = this.resolveCurrency(items);
    // Net of refunds (credit_card_refund), shared with getBill. `charges` is the
    // set we mark paid — refunds are credits, never "paid".
    const {
      totalMoney,
      unpaidTotalMoney: unpaidMoney,
      chargesTotalMoney,
      paidTotalMoney,
      charges,
    } = BillService.computeBillTotals(items, currency);

    // Defense-in-depth: more charges marked paid than charges that exist is the
    // true data-corruption signal. Refunds are intentionally NOT part of this
    // check — a refund/"saldo anterior" exceeding the charges drives the net
    // total (and unpaidMoney) legitimately below zero (a credit bill), which is
    // valid, not corruption.
    if (paidTotalMoney.isGreaterThan(chargesTotalMoney)) {
      throw new InvariantViolationError(
        `Bill paidTotal exceeds charges for card=${cardAccountId} ${month}/${year}`,
        {
          cardAccountId,
          month,
          year,
          paidTotal: paidTotalMoney.toDbString(),
          chargesTotal: chargesTotalMoney.toDbString(),
        },
      );
    }
    if (unpaidMoney.isNegative() || unpaidMoney.isZero()) {
      // Nothing to pay (zero owed or a net credit). SKIP — do NOT throw, so a
      // sibling card in the same cascade can still be paid. payBill turns an
      // all-skipped result into the "nothing to pay" error.
      return { paid: false };
    }
    if (currency !== 'BRL')
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Bill and wallet currencies must be BRL.',
        cause: errorCause('bill.invalidPaymentWallet'),
      });

    const txTransactionService = new TransactionService(tx);

    // Create transfer: bank → credit card (only for unpaid portion). The
    // partial unique index `tx_bill_payment_unique` enforces idempotency at
    // the DB layer — concurrent callers racing on the same bill fail here
    // with SQLSTATE 23505, mapped to CONFLICT in payBill's catch.
    const transfer = await txTransactionService.createWithinCardFlow(
      createCardWriteContext(userId),
      userId,
      {
        sourceAccountId: paidFromAccountId,
        destinationAccountId: cardAccountId,
        amount: unpaidMoney.toDbString(),
        description: `Pagamento fatura - ${month}/${year}`,
        date: settledAt,
        billingMonth: month,
        billingYear: year,
        domainType: 'bill_payment' satisfies DomainType,
      },
    );
    const settledTransfer = await new SettlementService(tx).settleBillPayment(
      createCardWriteContext(userId),
      userId,
      { transactionId: transfer.id, walletAccountId: paidFromAccountId, settledAt },
    );

    // Mark unpaid CHARGES as paid (userId in WHERE for defense-in-depth).
    // Refund rows are credits — they are never marked paid.
    let markedCount = 0;
    for (const t of charges) {
      if (!t.isPaid) {
        await tx
          .update(transactions)
          .set({ isPaid: true, paidAt: settledAt, paidFromAccountId })
          .where(and(eq(transactions.id, t.id), eq(transactions.userId, userId)));
        markedCount++;
      }
    }

    // Upsert credit_card_bills record (this card's own row).
    const now = settledAt;
    await tx
      .insert(creditCardBills)
      .values({
        creditCardAccountId: cardAccountId,
        month,
        year,
        totalAmount: totalMoney.toDbString(),
        status: 'paid',
        paidAmount: unpaidMoney.toDbString(),
        paidAt: now,
      })
      .onConflictDoUpdate({
        target: [creditCardBills.creditCardAccountId, creditCardBills.month, creditCardBills.year],
        set: {
          status: 'paid',
          paidAmount: unpaidMoney.toDbString(),
          paidAt: now,
          totalAmount: totalMoney.toDbString(),
        },
      });

    return { paid: true, transfer: settledTransfer, unpaid: unpaidMoney, markedCount, currency };
  }

  /**
   * Resolve a single authoritative currency for a set of bill items. Throws
   * `InvariantViolationError` if items have heterogeneous currencies — we
   * cannot safely sum across currencies without an FX rate (handled by a
   * separate flow). Null currency defaults to `'BRL'` for now (Task 9 will
   * make `transactions.currency` NOT NULL with DEFAULT 'BRL' at the DB level
   * and this default will become unreachable).
   */
  private resolveCurrency(items: Array<{ currency?: string | null }>): string {
    const set = new Set(items.map((i) => i.currency ?? 'BRL'));
    if (set.size > 1) {
      throw new InvariantViolationError(`Mixed currencies in bill items: ${[...set].join(', ')}`, {
        currencies: [...set],
        ...errorCause('bill.mixedCurrency'),
      });
    }
    // Empty items → `set.size === 0` → fallback to 'BRL'. This branch is
    // unreachable from `payBill` (the zero-guard throws BusinessRuleError
    // before we'd ever resolve against an empty set) and harmless in
    // `getBill` where a zero-item bill trivially totals 0 regardless of
    // currency. Once Task 9 lands `transactions.currency NOT NULL DEFAULT
    // 'BRL'`, the `?? 'BRL'` on each item becomes unreachable too.
    return [...set][0] ?? 'BRL';
  }
}
