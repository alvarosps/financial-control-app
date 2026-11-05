import type { Database } from '@fc/db';
import { sql } from 'drizzle-orm';

/**
 * Structural subtype of `Database` covering only the API used by this helper
 * (plus by Drizzle transaction handles). Accepting this wider type avoids
 * forcing callers to `as unknown as Database` when passing a `tx` from
 * inside `db.transaction(async (tx) => ...)` — the tx handle lacks
 * `$client` but exposes the same `execute` surface.
 */
type DbExecutor = Pick<Database, 'execute'>;

export type BillLockPeriod = {
  cardAccountId: string;
  month: number;
  year: number;
};

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') return candidate.code;
  return postgresErrorCode(candidate.cause);
}

/**
 * Serialize bill-payment operations per (user, card account, billing period)
 * by acquiring a PostgreSQL transaction-scoped advisory lock.
 *
 * The lock key is derived from `bill:<userId>:<cardAccountId>:<YYYY>-<MM>`
 * hashed via `hashtextextended(key, 0)`. Because `pg_advisory_xact_lock`
 * is transaction-scoped, the lock is released automatically at COMMIT or
 * ROLLBACK, and repeated calls within the same transaction are no-ops.
 *
 * Must be invoked inside a PostgreSQL transaction (e.g., via
 * `db.transaction(async (tx) => ...)`). Calling this on a non-transaction
 * handle throws synchronously (well, asynchronously on the first query).
 */
export async function acquireBillLock(
  tx: DbExecutor,
  userId: string,
  cardAccountId: string,
  month: number,
  year: number,
): Promise<void> {
  await acquireBillLocks(tx, userId, [{ cardAccountId, month, year }]);
}

/**
 * Acquires a deterministic, de-duplicated set of bill locks. Card write paths
 * must take the user materialization lock before calling this helper.
 */
export async function acquireBillLocks(
  tx: DbExecutor,
  userId: string,
  periods: readonly BillLockPeriod[],
): Promise<void> {
  // Detect transaction context by issuing a SAVEPOINT. Savepoints can only
  // be created inside an explicit transaction block; outside one, PostgreSQL
  // raises `25P01 no_active_sql_transaction` ("SAVEPOINT can only be used in
  // transaction blocks"). This is more reliable than
  // `pg_current_xact_id_if_assigned()` which returns NULL for read-only
  // transactions that have not yet been assigned a real xid.
  try {
    await tx.execute(sql`SAVEPOINT __bill_lock_tx_probe`);
    await tx.execute(sql`RELEASE SAVEPOINT __bill_lock_tx_probe`);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '25P01') {
      throw new Error('acquireBillLock must run inside a transaction');
    }
    throw err;
  }

  const uniquePeriods = [
    ...new Map(
      periods.map((period) => [`${period.cardAccountId}:${period.year}:${period.month}`, period]),
    ).values(),
  ].sort((left, right) =>
    `${left.cardAccountId}:${left.year}:${left.month}`.localeCompare(
      `${right.cardAccountId}:${right.year}:${right.month}`,
    ),
  );

  for (const { cardAccountId, month, year } of uniquePeriods) {
    const mm = String(month).padStart(2, '0');
    const key = `bill:${userId}:${cardAccountId}:${year}-${mm}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}
