/**
 * Utilities for interpreting Postgres error codes and constraint names.
 * Works with postgres-js (used by drizzle-orm/postgres-js): error objects expose
 * `code` (SQLSTATE) and `constraint_name`. We defensively check both `constraint_name`
 * and `constraint` to stay compatible across driver versions.
 */

type PgLikeError = {
  code?: string;
  constraint_name?: string;
  constraint?: string;
};

/** Drizzle and tRPC wrap driver errors; inspect the bounded cause chain, never query text. */
function postgresError(error: unknown): { code: string; message?: unknown } | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (typeof current === 'object' && current !== null && seen.size < 10 && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown; message?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return { code: candidate.code, message: candidate.message };
    }
    current = candidate.cause;
  }
  return undefined;
}

export function getPostgresErrorCode(error: unknown): string | undefined {
  return postgresError(error)?.code;
}

export function isClosedFinancialPeriodError(error: unknown): boolean {
  const cause = postgresError(error);
  return (
    cause?.code === 'P0001' &&
    cause.message === 'Financial period is closed; explicit reopening required'
  );
}

export function isTransientDatabaseError(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return code !== undefined && ['55P03', '57014', '40P01', '40001', '53300'].includes(code);
}

/**
 * Returns true when `err` is a Postgres unique-violation (SQLSTATE 23505).
 * If `constraintName` is provided, also checks that the violated constraint
 * matches — useful to distinguish which index triggered the failure.
 */
export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as PgLikeError;
  if (e.code !== '23505') return false;
  if (!constraintName) return true;
  return e.constraint_name === constraintName || e.constraint === constraintName;
}

/** Returns true when `err` is a Postgres check-constraint violation (SQLSTATE 23514). */
export function isCheckViolation(err: unknown, constraintName?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as PgLikeError;
  if (e.code !== '23514') return false;
  if (!constraintName) return true;
  return e.constraint_name === constraintName || e.constraint === constraintName;
}

/** Returns true when `err` is a Postgres foreign-key violation (SQLSTATE 23503). */
export function isForeignKeyViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as PgLikeError;
  return e.code === '23503';
}
