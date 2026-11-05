import type { Database } from './client.ts';

/**
 * Accepts both a top-level Drizzle handle and a transaction handle passed
 * into `db.transaction(async (tx) => { ... })`.
 *
 * Use this as the parameter type for any service method/constructor that
 * operates either at the root or inside a transaction, to avoid
 * `tx as unknown as Database` casts at call sites.
 */
export type DbExecutor = Parameters<Parameters<Database['transaction']>[0]>[0] | Database;
