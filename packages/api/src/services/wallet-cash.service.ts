import type { DbExecutor } from '@fc/db';
import { accounts, transactions } from '@fc/db';
import type { AccountType } from '@fc/domain';
import { Money } from '@fc/domain';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { cashInWindow, cashMovementDay, cashValueBrl } from '../lib/cash-selection.ts';

const WALLET_TYPES: AccountType[] = ['checking'];
const EPOCH = new Date('1970-01-01T00:00:00Z');

export type WalletCash = {
  id: string;
  name: string;
  currency: string;
  isDefaultWallet: boolean;
  openingBalance: string;
  overdraftLimit: string | null;
  cash: number;
  assumedDelta: number;
  legacyMovementCount: number;
  unresolvedMovementCount: number;
  anchorBasis: 'recorded' | 'effective';
};

export type WalletCashOverview = {
  wallets: WalletCash[];
  totalCash: number;
};

export type WalletCashPoint = {
  /** America/Sao_Paulo calendar day, formatted as YYYY-MM-DD. */
  date: string;
  /** Cumulative canonical cash across all BRL wallets at the end of the day. */
  total: number;
};

const SAO_PAULO_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function saoPauloDateKey(value: Date): string {
  const parts = SAO_PAULO_DATE_FORMATTER.formatToParts(value);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}`;
}

function shiftDateKey(dateKey: string, days: number): string {
  const shifted = new Date(`${dateKey}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Shared BRL cash selection preserves recorded anchors until a reviewed effective-date cutover. */
export class WalletCashService {
  constructor(private db: DbExecutor) {}

  async getWalletCash(userId: string, asOf: Date = new Date()): Promise<WalletCashOverview> {
    const wallets = await this.db
      .select({
        id: accounts.id,
        name: accounts.name,
        currency: accounts.currency,
        isDefaultWallet: accounts.isDefaultWallet,
        openingBalance: accounts.openingBalance,
        openingBalanceAnchorAt: accounts.openingBalanceAnchorAt,
        cashAnchorBasis: accounts.cashAnchorBasis,
        overdraftLimit: accounts.overdraftLimit,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.isActive, true),
          eq(accounts.currency, 'BRL'),
          inArray(accounts.type, WALLET_TYPES),
        ),
      );

    const result: WalletCash[] = [];
    let total = Money.zero('BRL');

    for (const w of wallets) {
      const anchor = w.openingBalanceAnchorAt ?? EPOCH;
      const [row] = await this.db
        .select({
          incoming: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.destinationAccountId} = ${w.id} AND ${transactions.settlementSource} <> 'date_assumed' THEN ${cashValueBrl} ELSE 0 END), 0)`,
          outgoing: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.sourceAccountId} = ${w.id} AND ${transactions.settlementSource} <> 'date_assumed' THEN ${cashValueBrl} ELSE 0 END), 0)`,
          assumed: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.settlementSource} = 'date_assumed' THEN ${cashValueBrl} * (CASE WHEN ${transactions.destinationAccountId} = ${w.id} THEN 1 ELSE 0 END - CASE WHEN ${transactions.sourceAccountId} = ${w.id} THEN 1 ELSE 0 END) ELSE 0 END), 0)`,
          legacy: sql<number>`COUNT(*) FILTER (WHERE ${transactions.settlementSource} = 'legacy')::int`,
          unresolved: sql<number>`COUNT(*) FILTER (WHERE ${cashValueBrl} IS NULL)::int`,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            cashInWindow(anchor, w.cashAnchorBasis, asOf, true),
            or(eq(transactions.destinationAccountId, w.id), eq(transactions.sourceAccountId, w.id)),
          ),
        );

      const cash = Money.fromString(w.openingBalance, 'BRL')
        .add(Money.fromString(row?.incoming ?? '0', 'BRL'))
        .subtract(Money.fromString(row?.outgoing ?? '0', 'BRL'));
      total = total.add(cash);

      result.push({
        id: w.id,
        name: w.name,
        currency: w.currency,
        isDefaultWallet: w.isDefaultWallet,
        openingBalance: w.openingBalance,
        overdraftLimit: w.overdraftLimit,
        cash: cash.toNumber(),
        assumedDelta: Money.fromString(row?.assumed ?? '0', 'BRL').toNumber(),
        legacyMovementCount: row?.legacy ?? 0,
        unresolvedMovementCount: row?.unresolved ?? 0,
        anchorBasis: w.cashAnchorBasis,
      });
    }

    return { wallets: result, totalCash: total.toNumber() };
  }

  /**
   * Returns the daily canonical-cash series from `today - days` through today.
   * The first query reads the active BRL wallets; the second expands every paid
   * transaction into the relevant wallet leg and aggregates by day. That keeps
   * the read path at two statements regardless of wallet count.
   */
  async getWalletCashSeries(
    userId: string,
    days = 30,
    asOf: Date = new Date(),
  ): Promise<WalletCashPoint[]> {
    const today = saoPauloDateKey(asOf);
    const requestedStart = shiftDateKey(today, -days);

    const wallets = await this.db
      .select({
        id: accounts.id,
        openingBalance: accounts.openingBalance,
        openingBalanceAnchorAt: accounts.openingBalanceAnchorAt,
        cashAnchorBasis: accounts.cashAnchorBasis,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.isActive, true),
          eq(accounts.currency, 'BRL'),
          inArray(accounts.type, WALLET_TYPES),
        ),
      );

    const latestAnchor = wallets.reduce<string | undefined>((latest, wallet) => {
      if (!wallet.openingBalanceAnchorAt) return latest;
      const anchorDay = saoPauloDateKey(wallet.openingBalanceAnchorAt);
      if (anchorDay < requestedStart || anchorDay > today) return latest;
      return !latest || anchorDay > latest ? anchorDay : latest;
    }, undefined);
    const effectiveStart = latestAnchor ?? requestedStart;

    const daysToEmit: string[] = [];
    for (let day = effectiveStart; day <= today; day = shiftDateKey(day, 1)) {
      daysToEmit.push(day);
    }

    if (wallets.length === 0) {
      return daysToEmit.map((date) => ({ date, total: 0 }));
    }

    const walletRows = sql.join(
      wallets.map(
        (wallet) =>
          sql`(${wallet.id}::uuid, ${(wallet.openingBalanceAnchorAt ?? EPOCH).toISOString()}::timestamptz, ${wallet.cashAnchorBasis}::text)`,
      ),
      sql`, `,
    );
    const rows = await this.db.execute<{ day: string | null; delta: string }>(sql`
      WITH wallet_anchors(id, anchor_at, basis) AS (
        VALUES ${walletRows}
      ), movement_legs AS (
        SELECT
          CASE
            WHEN ${cashMovementDay} < ${effectiveStart}::date THEN NULL
            ELSE to_char(${cashMovementDay}, 'YYYY-MM-DD')
          END AS day,
          CASE
            WHEN ${transactions.sourceAccountId} = wallet_anchors.id
              AND ${transactions.destinationAccountId} = wallet_anchors.id THEN 0
            WHEN ${transactions.destinationAccountId} = wallet_anchors.id
              THEN ${cashValueBrl}
            ELSE -${cashValueBrl}
          END AS delta
        FROM ${transactions}
        INNER JOIN wallet_anchors
          ON ${transactions.destinationAccountId} = wallet_anchors.id
          OR ${transactions.sourceAccountId} = wallet_anchors.id
        WHERE ${transactions.userId} = ${userId}
          AND wallet_cash_in_window(${transactions}, wallet_anchors.anchor_at, wallet_anchors.basis, ${asOf.toISOString()}::timestamptz)
      )
      SELECT
        day,
        COALESCE(SUM(delta), 0)::text AS delta
      FROM movement_legs
      GROUP BY day
      ORDER BY day NULLS FIRST
    `);

    const deltasByDay = new Map<string, Money>();
    let running = wallets.reduce(
      (total, wallet) => total.add(Money.fromString(wallet.openingBalance, 'BRL')),
      Money.zero('BRL'),
    );
    for (const row of rows) {
      const delta = Money.fromString(row.delta, 'BRL');
      if (row.day === null) {
        running = running.add(delta);
      } else {
        deltasByDay.set(row.day, delta);
      }
    }

    return daysToEmit.map((date) => {
      running = running.add(deltasByDay.get(date) ?? Money.zero('BRL'));
      return { date, total: running.toNumber() };
    });
  }
}
