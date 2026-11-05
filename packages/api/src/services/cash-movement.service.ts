import { accounts, type DbExecutor, transactions } from '@fc/db';
import { Money } from '@fc/domain';
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { cashMovementDay, cashValueBrl } from '../lib/cash-selection.ts';

export class CashMovementService {
  constructor(private db: DbExecutor) {}
  async list(
    userId: string,
    input: { month: number; year: number; accountId?: string; page: number; pageSize: number },
  ) {
    const wallets = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'checking'),
          eq(accounts.currency, 'BRL'),
        ),
      );
    const ids = wallets
      .filter((w) => !input.accountId || w.id === input.accountId)
      .map((w) => w.id);
    if (!ids.length)
      return { items: [], total: 0, incoming: '0.00', outgoing: '0.00', unconfirmedCount: 0 };
    const start = `${input.year}-${String(input.month).padStart(2, '0')}-01`;
    const end = new Date(Date.UTC(input.year, input.month, 0)).toISOString().slice(0, 10);
    const sign = sql<number>`(CASE WHEN ${inArray(transactions.destinationAccountId, ids)} THEN 1 ELSE 0 END - CASE WHEN ${inArray(transactions.sourceAccountId, ids)} THEN 1 ELSE 0 END)`;
    const confirmed = sql<boolean>`${transactions.settlementSource} IN ('manual','bank','payroll') AND ${transactions.settlementDate} IS NOT NULL AND ${cashValueBrl} IS NOT NULL`;
    const selection = this.db
      .select({
        id: transactions.id,
        name: transactions.description,
        date: cashMovementDay.as('movement_day'),
        amount: cashValueBrl.as('cash_brl'),
        source: transactions.sourceAccountId,
        destination: transactions.destinationAccountId,
        evidence: transactions.settlementSource,
        confirmed: confirmed.as('confirmed'),
        signedAmount: sql<string | null>`${cashValueBrl} * ${sign}`.as('signed_amount'),
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isPaid, true),
          lte(
            sql`COALESCE(${transactions.settlementDate}, ${transactions.date}::timestamptz)`,
            new Date().toISOString(),
          ),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          ne(transactions.settlementSource, 'date_assumed'),
          gte(cashMovementDay, start),
          lte(cashMovementDay, end),
          or(
            inArray(transactions.sourceAccountId, ids),
            inArray(transactions.destinationAccountId, ids),
          ),

          or(
            isNull(transactions.domainType),
            inArray(transactions.domainType, [
              'bill_payment',
              'loan_payment',
              'loan_insurance',
              'recurring_bill',
              'income_clt',
              'income_pj',
              'income_rental',
              'family_loan_payment',
            ]),
          ),
        ),
      )
      .as('cash_movements');
    const [totals] = await this.db
      .select({
        total: sql<number>`COUNT(*)::int`,
        incoming: sql<string>`COALESCE(SUM(CASE WHEN ${selection.confirmed} AND ${selection.signedAmount}>0 THEN ${selection.signedAmount} ELSE 0 END),0)::text`,
        outgoing: sql<string>`COALESCE(SUM(CASE WHEN ${selection.confirmed} AND ${selection.signedAmount}<0 THEN -${selection.signedAmount} ELSE 0 END),0)::text`,
        unconfirmedCount: sql<number>`COUNT(*) FILTER (WHERE NOT ${selection.confirmed})::int`,
      })
      .from(selection);
    const rows = await this.db
      .select()
      .from(selection)
      .orderBy(desc(selection.date), selection.id)
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize);
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        date: row.date,
        amount:
          row.signedAmount === null ? null : Money.fromString(row.signedAmount, 'BRL').toDbString(),
        evidence: row.evidence,
        confirmed: row.confirmed,
      })),
      total: totals.total,
      incoming: Money.fromString(totals.incoming, 'BRL').toDbString(),
      outgoing: Money.fromString(totals.outgoing, 'BRL').toDbString(),
      unconfirmedCount: totals.unconfirmedCount,
    };
  }
}
