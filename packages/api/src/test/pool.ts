import type { Database } from '@fc/db';
import { createDb } from '@fc/db';
import { configureTestDatabaseEnvironment } from '../../../../scripts/lib/database-target.ts';

/**
 * Shared singleton test DB handle. All `withRollback` calls reuse the same
 * underlying postgres-js client pool so we don't leak one connection per
 * test (which would quickly exhaust postgres' max_connections under shuffle
 * + parallelism).
 *
 * `TEST_DATABASE_URL` is the canonical env var; we fall back to the
 * historical `DATABASE_URL_TEST` name so tests keep working if a CI runner
 * still sets the old variable.
 */
export function getTestDb(): Database {
  const url = configureTestDatabaseEnvironment(process.env);
  if (!_cached) {
    _cached = createDb(url);
  }
  return _cached;
}

let _cached: Database | null = null;
