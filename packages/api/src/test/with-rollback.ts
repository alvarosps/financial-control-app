import type { DbExecutor } from '@fc/db';
import { getTestDb } from './pool.ts';

/**
 * Internal sentinel used to force the outer transaction to roll back
 * without surfacing as a test error. Callers of `withRollback` never see it.
 */
const ROLLBACK_SENTINEL = Symbol('withRollback.force-rollback');

class _RollbackError extends Error {
  readonly [ROLLBACK_SENTINEL] = true;
  constructor() {
    super('withRollback: forced rollback');
  }
}

/**
 * Run `fn` inside a fresh database transaction that is *always* rolled back
 * after `fn` resolves or rejects, providing hermetic per-test isolation
 * without any manual cleanup. The `db` argument passed to `fn` is a Drizzle
 * transaction handle — any nested `db.transaction(...)` inside `fn` becomes
 * a SAVEPOINT underneath the outer rollback, matching real production code
 * paths.
 *
 * Errors thrown inside `fn` (including assertion failures, service errors,
 * and database errors) are re-raised to the test runner *after* the
 * transaction has rolled back.
 */
export async function withRollback<T>(fn: (db: DbExecutor) => Promise<T>): Promise<T> {
  const root = getTestDb();
  let value: T | undefined;
  let thrown: unknown;

  try {
    await root.transaction(async (tx) => {
      try {
        value = await fn(tx);
      } catch (err) {
        thrown = err;
      }
      // Always throw to trigger the outer rollback. If `fn` threw, we've
      // captured the original error; if it succeeded, we throw the sentinel
      // and swallow it below.
      throw new _RollbackError();
    });
  } catch (err) {
    if (!(err instanceof _RollbackError)) {
      // Unexpected error from the transaction machinery itself; surface it.
      throw err;
    }
  }

  if (thrown !== undefined) {
    throw thrown;
  }
  // Safe cast: if `fn` completed without throwing, `value` was assigned.
  return value as T;
}
