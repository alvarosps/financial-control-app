import type { DbExecutor } from '@fc/db';
import { borrowedCards, scheduledTransactions, transactions } from '@fc/db';
import { allocateFamilyLoanPayments, Money } from '@fc/domain';
import { addMonths, monthIndex } from '@fc/shared';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import { FamilyLoanPaymentService } from './family-loan-payment.service.ts';
import { loadFamilyLoanConfig } from './family-loan-shared.ts';
import { StatementCycleService, statementKey } from './statement-cycle.service.ts';

/**
 * Leitores do razão do empréstimo familiar (owed por mês, total mensal
 * itemizado, projeção e ledger alocado). Extraído de FamilyLoanFlowService,
 * que delega para cá.
 */
export class FamilyLoanLedgerService {
  private paymentService: FamilyLoanPaymentService;

  constructor(private db: DbExecutor) {
    this.paymentService = new FamilyLoanPaymentService(db);
  }

  private async borrowedTotals(userId: string, cardIds: string[]) {
    if (!cardIds.length) return [];
    const rows = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          or(
            inArray(transactions.destinationAccountId, cardIds),
            inArray(transactions.sourceAccountId, cardIds),
          ),
        ),
      );
    const entries = rows.flatMap((row) => {
      if (row.domainType === 'bill_payment') return [];
      const incoming = cardIds.includes(row.destinationAccountId);
      if (!incoming && row.type !== 'deposit') return [];
      const cardId = incoming ? row.destinationAccountId : row.sourceAccountId;
      const ref =
        row.billingMonth !== null &&
        row.billingMonth >= 1 &&
        row.billingMonth <= 12 &&
        row.billingYear !== null
          ? { cardAccountId: cardId, month: row.billingMonth, year: row.billingYear }
          : null;
      const amount = Money.fromString(row.amount, 'BRL');
      return [
        {
          row,
          cardId,
          ref,
          amount: !incoming || row.domainType === 'credit_card_refund' ? amount.negate() : amount,
        },
      ];
    });
    const refs = new Map(
      entries.flatMap(({ ref }) => (ref ? [[statementKey(ref), ref] as const] : [])),
    );
    const cycles = await new StatementCycleService(this.db).resolveMany(userId, [...refs.values()]);
    const totals = new Map<string, { cardId: string; monthKey: string; amount: Money }>();
    for (const entry of entries) {
      const due = entry.ref ? cycles.get(statementKey(entry.ref))?.dueDate : null;
      const monthKey =
        due?.slice(0, 7) ??
        (entry.ref
          ? `${entry.ref.year}-${String(entry.ref.month).padStart(2, '0')}`
          : entry.row.date.toISOString().slice(0, 7));
      const key = `${entry.cardId}:${monthKey}`;
      const previous = totals.get(key);
      totals.set(key, {
        cardId: entry.cardId,
        monthKey,
        amount: (previous?.amount ?? Money.zero('BRL')).add(entry.amount),
      });
    }
    return [...totals.values()];
  }

  /** Earliest month with any owed activity (charges by date, borrowed-card by statement due month). null if none. */
  async firstOwedMonth(
    userId: string,
    configId: string,
  ): Promise<{ month: number; year: number } | null> {
    const config = await loadFamilyLoanConfig(this.db, userId, configId);
    const [chargeMin] = await this.db
      .select({ d: sql<string | null>`MIN(${transactions.date})` })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isReversed, false),
          inArray(transactions.domainType, [
            'family_loan_installment',
            'family_loan_fixed_charge',
            'family_loan_expense',
            'family_loan_discount',
          ]),
          or(
            eq(transactions.sourceAccountId, config.accountId),
            eq(transactions.destinationAccountId, config.accountId),
          ),
        ),
      );
    const cards = await this.db
      .select()
      .from(borrowedCards)
      .where(eq(borrowedCards.familyLoanConfigId, config.id));
    let earliest: { month: number; year: number } | null = null;
    if (chargeMin?.d) {
      const d = new Date(chargeMin.d);
      earliest = { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
    }
    const cardIds = cards.map((c) => c.creditCardAccountId);
    for (const row of await this.borrowedTotals(userId, cardIds)) {
      const [year, month] = row.monthKey.split('-').map(Number);
      if (!earliest || year * 12 + month < earliest.year * 12 + earliest.month)
        earliest = { month, year };
    }
    return earliest;
  }

  async owedByMonthRange(
    userId: string,
    configId: string,
    from: { month: number; year: number },
    to: { month: number; year: number },
  ): Promise<Array<{ monthKey: string; owed: number; borrowedCardTotal: number }>> {
    const config = await loadFamilyLoanConfig(this.db, userId, configId);
    const startDate = new Date(Date.UTC(from.year, from.month - 1, 1));
    const endDate = new Date(Date.UTC(to.year, to.month, 0));
    const chargeRows = await this.db
      .select({
        mk: sql<string>`to_char(${transactions.date}, 'YYYY-MM')`,
        total: sql<string>`COALESCE(SUM(${transactions.amount}::numeric), 0)`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.sourceAccountId, config.accountId),
          eq(transactions.isReversed, false),
          or(
            eq(transactions.domainType, 'family_loan_installment'),
            eq(transactions.domainType, 'family_loan_fixed_charge'),
            eq(transactions.domainType, 'family_loan_expense'),
          ),
          gte(transactions.date, startDate),
          lte(transactions.date, endDate),
        ),
      )
      .groupBy(sql`to_char(${transactions.date}, 'YYYY-MM')`);
    const discountRows = await this.db
      .select({
        mk: sql<string>`to_char(${transactions.date}, 'YYYY-MM')`,
        total: sql<string>`COALESCE(SUM(${transactions.amount}::numeric), 0)`,
      })
      .from(transactions)
      .leftJoin(
        scheduledTransactions,
        eq(scheduledTransactions.id, transactions.scheduledTransactionId),
      )
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.domainType, 'family_loan_discount'),
          eq(transactions.isReversed, false),
          gte(transactions.date, startDate),
          lte(transactions.date, endDate),
          or(
            eq(scheduledTransactions.domainConfigId, config.id),
            eq(transactions.sourceAccountId, config.accountId),
            eq(transactions.destinationAccountId, config.accountId),
          ),
        ),
      )
      .groupBy(sql`to_char(${transactions.date}, 'YYYY-MM')`);
    const cards = await this.db
      .select({ creditCardAccountId: borrowedCards.creditCardAccountId })
      .from(borrowedCards)
      .where(eq(borrowedCards.familyLoanConfigId, config.id));
    const fromKey = `${from.year}-${String(from.month).padStart(2, '0')}`;
    const toKey = `${to.year}-${String(to.month).padStart(2, '0')}`;
    const borrowedNetMoney = new Map<string, Money>();
    const cardIds = cards.map((c) => c.creditCardAccountId);
    for (const row of await this.borrowedTotals(userId, cardIds)) {
      if (row.monthKey < fromKey || row.monthKey > toKey) continue;
      const previous = borrowedNetMoney.get(row.monthKey) ?? Money.zero('BRL');
      borrowedNetMoney.set(row.monthKey, previous.add(row.amount));
    }
    const chargeByMonth = new Map(
      chargeRows.map((row) => [row.mk, Money.fromString(row.total, 'BRL')]),
    );
    const discountByMonth = new Map(
      discountRows.map((row) => [row.mk, Money.fromString(row.total, 'BRL')]),
    );
    const result: Array<{ monthKey: string; owed: number; borrowedCardTotal: number }> = [];
    const toIdx = monthIndex(to);
    for (let cursor = from; monthIndex(cursor) <= toIdx; cursor = addMonths(cursor, 1)) {
      const monthKey = `${cursor.year}-${String(cursor.month).padStart(2, '0')}`;
      const charges = chargeByMonth.get(monthKey) ?? Money.zero('BRL');
      const discounts = discountByMonth.get(monthKey) ?? Money.zero('BRL');
      const borrowedMoney = borrowedNetMoney.get(monthKey) ?? Money.zero('BRL');
      result.push({
        monthKey,
        owed: charges.add(borrowedMoney).subtract(discounts).toNumber(),
        borrowedCardTotal: borrowedMoney.toNumber(),
      });
    }
    return result;
  }

  async getMonthlyTotal(userId: string, configId: string, month: number, year: number) {
    const config = await loadFamilyLoanConfig(this.db, userId, configId);
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));
    const monthlyTxs = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.sourceAccountId, config.accountId),
          eq(transactions.isReversed, false),
          gte(transactions.date, startDate),
          lte(transactions.date, endDate),
        ),
      );
    const sum = (domainType: string) =>
      Money.sum(
        monthlyTxs
          .filter((t) => t.domainType === domainType)
          .map((t) => Money.fromString(t.amount, 'BRL')),
        'BRL',
      );
    const installments = sum('family_loan_installment');
    const fixedCharges = sum('family_loan_fixed_charge');
    const oneTimeCharges = sum('family_loan_expense');
    const discountRows = await this.db
      .select({
        id: transactions.id,
        description: transactions.description,
        amount: transactions.amount,
        installmentNumber: transactions.installmentNumber,
        totalInstallments: transactions.totalInstallments,
        scheduledTransactionId: transactions.scheduledTransactionId,
        domainType: transactions.domainType,
        isPaid: transactions.isPaid,
      })
      .from(transactions)
      .leftJoin(
        scheduledTransactions,
        eq(scheduledTransactions.id, transactions.scheduledTransactionId),
      )
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.domainType, 'family_loan_discount'),
          eq(transactions.isReversed, false),
          gte(transactions.date, startDate),
          lte(transactions.date, endDate),
          or(
            eq(scheduledTransactions.domainConfigId, config.id),
            eq(transactions.sourceAccountId, config.accountId),
            eq(transactions.destinationAccountId, config.accountId),
          ),
        ),
      );
    const discounts = Money.sum(
      discountRows.map((t) => Money.fromString(t.amount, 'BRL')),
      'BRL',
    );
    const cards = await this.db
      .select()
      .from(borrowedCards)
      .where(eq(borrowedCards.familyLoanConfigId, config.id));
    let borrowedCardTotalMoney = Money.zero('BRL');
    const borrowedCardBreakdown: Array<{ creditCardAccountId: string; total: number }> = [];
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const cardTotals = await this.borrowedTotals(
      userId,
      cards.map((card) => card.creditCardAccountId),
    );
    for (const card of cards) {
      const cardTotal =
        cardTotals.find(
          (row) => row.cardId === card.creditCardAccountId && row.monthKey === monthKey,
        )?.amount ?? Money.zero('BRL');
      borrowedCardTotalMoney = borrowedCardTotalMoney.add(cardTotal);
      borrowedCardBreakdown.push({
        creditCardAccountId: card.creditCardAccountId,
        total: cardTotal.toNumber(),
      });
    }
    const borrowedCardTotal = borrowedCardTotalMoney.toNumber();
    const subtotal = installments.add(fixedCharges).add(oneTimeCharges).add(borrowedCardTotalMoney);
    const total = subtotal.subtract(discounts).toNumber();
    const toItem = (t: {
      id: string;
      description: string;
      amount: string;
      installmentNumber: number | null;
      totalInstallments: number | null;
      scheduledTransactionId: string | null;
      domainType: string | null;
      isPaid: boolean;
    }) => ({
      id: t.id,
      description: t.description,
      amount: t.amount,
      installmentNumber: t.installmentNumber,
      totalInstallments: t.totalInstallments,
      scheduledTransactionId: t.scheduledTransactionId,
      domainType: t.domainType,
      isPaid: t.isPaid,
    });
    return {
      month,
      year,
      installments: installments.toNumber(),
      fixedCharges: fixedCharges.toNumber(),
      oneTimeCharges: oneTimeCharges.toNumber(),
      borrowedCardTotal,
      borrowedCardBreakdown,
      discounts: discounts.toNumber(),
      subtotal: subtotal.toNumber(),
      total,
      items: {
        installments: monthlyTxs
          .filter((t) => t.domainType === 'family_loan_installment')
          .map(toItem),
        fixedCharges: monthlyTxs
          .filter((t) => t.domainType === 'family_loan_fixed_charge')
          .map(toItem),
        expenses: monthlyTxs.filter((t) => t.domainType === 'family_loan_expense').map(toItem),
        discounts: discountRows.map(toItem),
      },
    };
  }

  /**
   * 12 meses de owed a partir do mês corrente, em UMA chamada de
   * owedByMonthRange (antes: 12 × getMonthlyTotal ≈ 60+ queries).
   * Shape enxuto — consumidores que precisam de itemização usam
   * getMonthlyTotal (fonte canônica de um mês).
   */
  async get12MonthProjection(
    userId: string,
    configId: string,
    currentPeriod: { month: number; year: number },
  ) {
    const from = currentPeriod;
    const to = addMonths(from, 11);

    const owed = await this.owedByMonthRange(userId, configId, from, to);
    const byKey = new Map(owed.map((o) => [o.monthKey, o]));

    const results: Array<{
      month: number;
      year: number;
      total: number;
      borrowedCardTotal: number;
    }> = [];
    for (let i = 0; i < 12; i++) {
      const ref = addMonths(from, i);
      const key = `${ref.year}-${String(ref.month).padStart(2, '0')}`;
      const row = byKey.get(key);
      results.push({
        month: ref.month,
        year: ref.year,
        total: row?.owed ?? 0,
        borrowedCardTotal: row?.borrowedCardTotal ?? 0,
      });
    }
    return results;
  }

  async getLedger(
    userId: string,
    configId: string,
    opts?: {
      asOf?: Date;
      currentPeriod?: { month: number; year: number };
      forwardMonths?: number;
    },
  ) {
    const asOf = opts?.asOf ?? new Date();
    const currentPeriod = opts?.currentPeriod ?? {
      month: asOf.getUTCMonth() + 1,
      year: asOf.getUTCFullYear(),
    };
    const forwardMonths = opts?.forwardMonths ?? 12;
    const first = await this.firstOwedMonth(userId, configId);
    const currentMonthKey = `${currentPeriod.year}-${String(currentPeriod.month).padStart(2, '0')}`;
    const from = first ?? currentPeriod;
    const owed = await this.owedByMonthRange(
      userId,
      configId,
      from,
      addMonths(currentPeriod, forwardMonths),
    );
    const payments = (await this.paymentService.listPayments(userId, configId)).filter(
      (payment) => payment.isPaid && new Date(payment.settlementDate ?? payment.date) <= asOf,
    );
    const ledger = allocateFamilyLoanPayments(
      owed.map((o) => ({ monthKey: o.monthKey, owed: Money.fromNumber(o.owed, 'BRL') })),
      payments.map((p) => ({
        date: typeof p.date === 'string' ? p.date : (p.date as Date).toISOString().slice(0, 10),
        amount: Money.fromString(p.amount, 'BRL'),
      })),
      currentMonthKey,
    );
    const borrowedByMonth = new Map(owed.map((o) => [o.monthKey, o.borrowedCardTotal]));
    return {
      months: ledger.months.map((mth) => ({
        ...mth,
        borrowedCardTotal: borrowedByMonth.get(mth.monthKey) ?? 0,
      })),
      totals: ledger.totals,
      payments: payments.map((p) => ({
        id: p.id,
        date: p.date,
        amount: p.amount,
        description: p.description,
        walletAccountId: p.destinationAccountId,
        cashAmount: p.cashAmount,
        settlementSource: p.settlementSource,
        settlementDate: p.settlementDate,
      })),
    };
  }
}
