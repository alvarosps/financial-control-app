import type { Database, DbExecutor } from '@fc/db';
import { sql } from 'drizzle-orm';

type TransactionExecutor = Exclude<DbExecutor, Database>;

const materializationLockBrand = Symbol('materialization-lock');

export type MaterializationLock = {
  readonly userId: string;
  readonly [materializationLockBrand]: true;
};

type LockedExecutor = {
  db: TransactionExecutor;
  lock: MaterializationLock;
};

function isRootDatabase(db: DbExecutor): db is Database {
  return 'transaction' in db && typeof db.transaction === 'function';
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') return candidate.code;
  return postgresErrorCode(candidate.cause);
}

async function assertTransaction(db: DbExecutor): Promise<void> {
  try {
    await db.execute(sql`SAVEPOINT __materialization_lock_tx_probe`);
    await db.execute(sql`RELEASE SAVEPOINT __materialization_lock_tx_probe`);
  } catch (error) {
    if (postgresErrorCode(error) === '25P01') {
      throw new Error('runWithMaterializationLock must run inside a transaction');
    }
    throw error;
  }
}

async function lockWithinTransaction<T>(
  db: TransactionExecutor,
  userId: string,
  callback: (locked: LockedExecutor) => Promise<T>,
): Promise<T> {
  await assertTransaction(db);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`);
  return callback({
    db,
    lock: { userId, [materializationLockBrand]: true },
  });
}

/**
 * Runs work under the single per-user, transaction-scoped materialization lock.
 * Root executors open a transaction; transaction executors are proved with a
 * SAVEPOINT and reuse the caller's transaction. This must never issue an xact
 * advisory lock on an autocommit connection.
 */
export async function runWithMaterializationLock<T>(
  db: DbExecutor,
  userId: string,
  callback: (locked: LockedExecutor) => Promise<T>,
): Promise<T> {
  if (isRootDatabase(db)) {
    return db.transaction(async (tx) => lockWithinTransaction(tx, userId, callback));
  }
  return lockWithinTransaction(db, userId, callback);
}

export function assertMaterializationLock(lock: MaterializationLock, userId: string): void {
  if (lock.userId !== userId) {
    throw new Error('Materialization lock does not belong to this user');
  }
}
