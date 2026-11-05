import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

/**
 * RLS POSTURE (real enforcement -- plan 03):
 *
 * The web runtime connects as the non-superuser `app_user` role
 * (APP_DATABASE_URL) with FORCE ROW LEVEL SECURITY on user-data tables. The
 * request transaction sets `app.current_user_id` in protectedProcedure
 * (packages/api/src/trpc.ts) through `SELECT set_config(..., true)`, i.e.
 * transaction-local, never session-level (the pool is shared across concurrent
 * users).
 *
 * Auth bootstrap uses the same transaction-local pattern with
 * `app.current_auth_user_id` to resolve user_profiles before app.current_user_id
 * exists.
 *
 * RLS is a backstop, not a substitute: every query/mutation still must filter by
 * `user_id` explicitly. Superuser connections (DATABASE_URL/TEST_DATABASE_URL
 * for tooling, migrations, and tests) bypass RLS by design.
 */
export function createDb(connectionString: string) {
  // Supabase's transaction pooler (port 6543) runs PgBouncer in transaction
  // mode, which is incompatible with postgres-js prepared statements. Disable
  // them only for that endpoint; the direct/local connection keeps prepared
  // statements (faster). Use a direct connection for maintenance operations.
  const usePooler = connectionString.includes(':6543');
  const client = postgres(connectionString, usePooler ? { prepare: false } : {});
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
