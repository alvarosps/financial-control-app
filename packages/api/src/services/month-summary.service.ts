import type { DbExecutor } from '@fc/db';
import { monthClosings, transactions } from '@fc/db';
import { getDomainTypesByGroup, Money } from '@fc/domain';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { IncomeOccurrenceService } from './income-occurrence.service.ts';

export type MonthSummary = {
  month: number;
  year: number;
  income: number;
  familyLoanIncome: number;
  totalIncome: number;
  creditCardExpenses: number;
  loanExpenses: number;
  chargeExpenses: number;
  otherExpenses: number;
  totalExpenses: number;
  balance: number;
  incomeUnavailableCount: number;
};

const CC_TYPES = getDomainTypesByGroup('credit_card');
const CC = new Set<string>(CC_TYPES);
const LOAN = new Set<string>(getDomainTypesByGroup('loan'));
const FAMILY = new Set<string>(getDomainTypesByGroup('family_loan'));
const INCOME = new Set<string>(getDomainTypesByGroup('income'));
const RECURRING = new Set<string>(getDomainTypesByGroup('recurring'));
const KNOWN = new Set<string>([...CC, ...LOAN, ...FAMILY, ...INCOME, ...RECURRING]);

export class MonthSummaryService {
  constructor(private db: DbExecutor) {}

  async getSummary(
    userId: string,
    month: number,
    year: number,
    opts?: { familyLoanIncomeOverride?: Money; unpaidOnly?: boolean },
  ): Promise<MonthSummary> {
    if (!opts?.unpaidOnly && opts?.familyLoanIncomeOverride === undefined) {
      const [closing] = await this.db
        .select({ revision: monthClosings.revision, data: monthClosings.detailedBreakdown })
        .from(monthClosings)
        .where(
          and(
            eq(monthClosings.userId, userId),
            eq(monthClosings.month, month),
            eq(monthClosings.year, year),
            eq(monthClosings.status, 'closed'),
          ),
        );
      const cached = z
        .object({
          summary: z.object({
            month: z.number(),
            year: z.number(),
            income: z.number(),
            familyLoanIncome: z.number(),
            totalIncome: z.number(),
            creditCardExpenses: z.number(),
            loanExpenses: z.number(),
            chargeExpenses: z.number(),
            otherExpenses: z.number(),
            totalExpenses: z.number(),
            balance: z.number(),
            incomeUnavailableCount: z.number(),
          }),
        })
        .safeParse(closing?.data);
      if (closing && closing.revision > 0 && cached.success) return cached.data.summary;
    }
    // UTC-constructed boundaries: the `date` column is UTC-midnight, so local
    // construction would shift month edges by a day in UTC−3 (off-by-one at
    // boundaries). Matches DailyControlService for calendar consistency.
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    // Date-windowed grouped rows for everything EXCEPT credit cards.
    const rows = await this.db
      .select({
        type: transactions.type,
        domainType: transactions.domainType,
        total: sql<string>`COALESCE(SUM(${transactions.amount}::numeric), 0)`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          opts?.unpaidOnly
            ? or(eq(transactions.isPaid, false), eq(transactions.settlementSource, 'date_assumed'))
            : undefined,
          gte(transactions.date, startDate),
          lte(transactions.date, endDate),
        ),
      )
      .groupBy(transactions.type, transactions.domainType);

    const sumWhere = (pred: (type: string, dt: string | null) => boolean) =>
      rows.reduce(
        (acc, r) => (pred(r.type, r.domainType) ? acc.add(Money.fromString(r.total, 'BRL')) : acc),
        Money.zero('BRL'),
      );

    const incomeSources = await new IncomeOccurrenceService(this.db).getOccurrences(
      userId,
      month,
      year,
    );
    const incomeOccurrences = incomeSources
      .flatMap((source) => source.occurrences)
      .filter((occ) => !opts?.unpaidOnly || !occ.isPaid || occ.settlementSource === 'date_assumed');
    const income = Money.sum(
      incomeOccurrences
        .filter((occ) => occ.amountBrl !== null)
        .map((occ) => Money.fromString(occ.amountBrl ?? '0', 'BRL')),
      'BRL',
    );
    // Callers that already computed family-loan owed for a span (e.g. the
    // 12-month projection, via owedByMonthRange) can pass it in to skip the
    // per-config getMonthlyTotal fan-out. owedByMonthRange == Σ getMonthlyTotal
    // (equivalence test), so the result is identical to the no-override path.
    const familyLoanIncome =
      opts?.familyLoanIncomeOverride ?? (await this.familyLoanOwedForMonth(userId, month, year));
    const loanExpenses = sumWhere(
      (t, dt) => (t === 'transfer' || t === 'withdrawal') && dt != null && LOAN.has(dt),
    );
    const chargeExpenses = sumWhere(
      (t, dt) => (t === 'withdrawal' || t === 'transfer') && dt != null && RECURRING.has(dt),
    );
    // Other = uncategorized withdrawals. Cards never here. Family-loan rows are
    // NEVER counted here: all family math (charges − discounts + borrowed-card)
    // is already captured by the config-derived familyLoanIncome above; counting
    // a family_loan_discount transfer here too would double-count it (once
    // reducing income, once as an expense). FAMILY stays in KNOWN so family
    // deposits aren't swept into `uncategorized`.
    const uncategorized = sumWhere((t, dt) => t === 'withdrawal' && (dt == null || !KNOWN.has(dt)));
    // Orphan rescue: credit_card-group rows with NULL billingMonth are excluded
    // from the billing-month bucket (NULL never equals `month`) AND from the
    // uncategorized bucket (CC group is in KNOWN). Without this they would
    // silently vanish, breaking the no-orphan invariant. Count them here.
    const orphanCardExpenses = await this.nullBillingCardExpenses(
      userId,
      startDate,
      endDate,
      opts?.unpaidOnly,
    );
    const otherExpenses = uncategorized.add(orphanCardExpenses);

    const creditCardExpenses = await this.cardExpensesByBillingMonth(userId, month, year);

    const totalIncome = income.add(familyLoanIncome);
    const totalExpenses = creditCardExpenses
      .add(loanExpenses)
      .add(chargeExpenses)
      .add(otherExpenses);
    const balance = totalIncome.subtract(totalExpenses);

    return {
      month,
      year,
      income: income.toNumber(),
      familyLoanIncome: familyLoanIncome.toNumber(),
      totalIncome: totalIncome.toNumber(),
      creditCardExpenses: creditCardExpenses.toNumber(),
      loanExpenses: loanExpenses.toNumber(),
      chargeExpenses: chargeExpenses.toNumber(),
      otherExpenses: otherExpenses.toNumber(),
      totalExpenses: totalExpenses.toNumber(),
      balance: balance.toNumber(),
      incomeUnavailableCount: incomeOccurrences.filter((occ) => occ.amountBrl === null).length,
    };
  }

  /** True family-loan owed for the month = Σ per-active-config getMonthlyTotal.total
   *  (installments+fixed+oneTime+borrowedCard − discounts; family_loan_payment excluded). */
  private async familyLoanOwedForMonth(
    userId: string,
    month: number,
    year: number,
  ): Promise<Money> {
    const flow = new FamilyLoanFlowService(this.db);
    const configs = await flow.list(userId);
    let total = Money.zero('BRL');
    for (const c of configs) {
      const t = await flow.getMonthlyTotal(userId, c.id, month, year);
      total = total.add(Money.fromNumber(t.total, 'BRL'));
    }
    return total;
  }

  /** Closing-month competence; confirmed due dates belong to the separate calendar/cash view. */
  private async cardExpensesByBillingMonth(
    userId: string,
    month: number,
    year: number,
  ): Promise<Money> {
    const rows = await this.db
      .select({
        domainType: transactions.domainType,
        total: sql<string>`COALESCE(SUM(${transactions.amount}::numeric), 0)`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          eq(transactions.billingMonth, month),
          eq(transactions.billingYear, year),
        ),
      )
      .groupBy(transactions.domainType);

    let gross = Money.zero('BRL');
    let refund = Money.zero('BRL');
    for (const r of rows) {
      const dt = r.domainType;
      if (dt == null || !CC.has(dt)) continue;
      // Net by domain type, independent of transaction `type` (mirrors
      // BillService): real refunds are stored as type:'withdrawal' with the card
      // as destination, so keying off `type` would add them instead of netting.
      if (dt === 'bill_payment') continue; // payments aren't expenses
      const amount = Money.fromString(r.total, 'BRL');
      if (dt === 'credit_card_refund') refund = refund.add(amount);
      else gross = gross.add(amount);
    }
    return gross.subtract(refund);
  }

  /**
   * Credit-card-group spend with a NULL billing month, dated within the month
   * window. These are orphans of the billing-month bucket and must still be
   * counted so no money silently vanishes. Netting mirrors
   * `cardExpensesByBillingMonth`: gross CC charges (except bill_payment) minus
   * credit_card_refund, keyed by domain type (not transaction `type`, since
   * refunds are stored as withdrawals with the card as destination).
   */
  private async nullBillingCardExpenses(
    userId: string,
    startDate: Date,
    endDate: Date,
    unpaidOnly = false,
  ): Promise<Money> {
    const rows = await this.db
      .select({
        domainType: transactions.domainType,
        total: sql<string>`COALESCE(SUM(${transactions.amount}::numeric), 0)`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          isNull(transactions.billingMonth),
          unpaidOnly
            ? or(eq(transactions.isPaid, false), eq(transactions.settlementSource, 'date_assumed'))
            : undefined,
          inArray(transactions.domainType, CC_TYPES),
          gte(transactions.date, startDate),
          lte(transactions.date, endDate),
        ),
      )
      .groupBy(transactions.domainType);

    let gross = Money.zero('BRL');
    let refund = Money.zero('BRL');
    for (const r of rows) {
      const dt = r.domainType;
      if (dt == null || !CC.has(dt)) continue;
      if (dt === 'bill_payment') continue; // payments aren't expenses
      const amount = Money.fromString(r.total, 'BRL');
      if (dt === 'credit_card_refund') refund = refund.add(amount);
      else gross = gross.add(amount);
    }
    return gross.subtract(refund);
  }
}
