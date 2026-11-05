import type { DbExecutor } from '@fc/db';
import { fxRates } from '@fc/db';
import { and, desc, eq, sql } from 'drizzle-orm';

import { toIso } from '../lib/calendar-dates.ts';
import { logger } from '../lib/logger.ts';

const USD = 'USD';
const BRL = 'BRL';

/** Constant, global advisory-lock key — FX rate is shared reference data, not per-user. */
const FX_LOCK_KEY = 'fx_rate_usd_brl';

export type FxFetcher = (base: string, quote: string) => Promise<{ rate: string; source: string }>;

/**
 * Default fetcher: reads the current USD→BRL bid from AwesomeAPI.
 * Throws on a non-200 response or a malformed payload so the caller can
 * fall back to the cached (stale) rate.
 */
export const defaultAwesomeApiFetcher: FxFetcher = async (base, quote) => {
  const pair = `${base}-${quote}`;
  const response = await fetch(`https://economia.awesomeapi.com.br/last/${pair}`);
  if (!response.ok) {
    throw new Error(`AwesomeAPI returned HTTP ${response.status} for ${pair}`);
  }

  const payload: unknown = await response.json();
  const key = `${base}${quote}`;
  if (typeof payload !== 'object' || payload === null || !(key in payload)) {
    throw new Error(`AwesomeAPI payload missing key ${key}`);
  }

  const entry = (payload as Record<string, unknown>)[key];
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`AwesomeAPI entry for ${key} is not an object`);
  }

  const bid = (entry as Record<string, unknown>).bid;
  if (typeof bid !== 'string' || bid.length === 0 || Number.isNaN(Number(bid))) {
    throw new Error(`AwesomeAPI bid for ${key} is not a valid number string`);
  }

  return { rate: bid, source: 'awesomeapi' };
};

export class FxRateService {
  constructor(
    private db: DbExecutor,
    private fetcher: FxFetcher = defaultAwesomeApiFetcher,
  ) {}

  /**
   * Refresh the USD→BRL rate at most once per local calendar day.
   *
   * Lock-free fast path: the overwhelming majority of requests find the rate
   * already fetched today and return without taking a lock. The slow path
   * serialises with a CONSTANT global advisory lock (FX rate is shared, not
   * per-user) and double-checks before fetching. A fetch failure never throws —
   * it is logged and the existing (stale-but-usable) row is left untouched.
   */
  async refreshIfStale(now: Date): Promise<void> {
    const today = toIso(now);

    // Lock-free fast path.
    const [existing] = await this.db
      .select({ fetchedOn: fxRates.fetchedOn })
      .from(fxRates)
      .where(and(eq(fxRates.baseCurrency, USD), eq(fxRates.quoteCurrency, BRL)))
      .orderBy(desc(fxRates.fetchedOn))
      .limit(1);
    if (existing && existing.fetchedOn === today) {
      return;
    }

    // Slow path: serialise globally so concurrent first-of-day requests cannot
    // both fetch and double-write.
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${FX_LOCK_KEY}::text, 0))`,
      );

      // Double-checked: a racing request may have already refreshed.
      const [current] = await tx
        .select({ fetchedOn: fxRates.fetchedOn })
        .from(fxRates)
        .where(and(eq(fxRates.baseCurrency, USD), eq(fxRates.quoteCurrency, BRL)))
        .orderBy(desc(fxRates.fetchedOn))
        .limit(1);
      if (current && current.fetchedOn === today) {
        return;
      }

      let fetched: { rate: string; source: string };
      try {
        fetched = await this.fetcher(USD, BRL);
      } catch (error) {
        // Stale-but-usable: leave the existing row untouched and resolve
        // normally so this never breaks a request.
        logger.warn(
          { err: error },
          'FX rate refresh failed; keeping existing USD/BRL rate (stale-but-usable)',
        );
        return;
      }

      await tx
        .insert(fxRates)
        .values({
          baseCurrency: USD,
          quoteCurrency: BRL,
          rate: fetched.rate,
          fetchedOn: today,
          fetchedAt: now,
          source: fetched.source,
        })
        .onConflictDoUpdate({
          target: [fxRates.baseCurrency, fxRates.quoteCurrency, fxRates.fetchedOn],
          set: {
            rate: fetched.rate,
            fetchedAt: now,
            source: fetched.source,
          },
        });

      // Sync the applied rate into income_source_configs for USD income sources
      // so the existing MonthCalc/Projection currency conversion keeps working.
      await tx.execute(sql`
        UPDATE income_source_configs
        SET exchange_rate = ${fetched.rate}, updated_at = now()
        WHERE account_id IN (
          SELECT DISTINCT source_account_id
          FROM scheduled_transactions
          WHERE currency = ${USD}
        )
      `);
    });
  }

  /** Read the cached rate for a currency pair, or null if none stored. */
  async getRate(base: string, quote: string): Promise<string | null> {
    const [row] = await this.db
      .select({ rate: fxRates.rate })
      .from(fxRates)
      .where(and(eq(fxRates.baseCurrency, base), eq(fxRates.quoteCurrency, quote)))
      .orderBy(desc(fxRates.fetchedOn))
      .limit(1);
    return row?.rate ?? null;
  }
}
