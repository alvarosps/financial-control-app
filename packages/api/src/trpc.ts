import type { DbExecutor } from '@fc/db';
import { BusinessRuleError, InvariantViolationError, NotFoundError } from '@fc/domain';
import { initTRPC, TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import superjson from 'superjson';
import { errorCause } from './lib/error-codes.ts';
import { isClosedFinancialPeriodError, isTransientDatabaseError } from './lib/pg-errors.ts';
import type { RequestProfileCache } from './lib/profile-cache.ts';
import { createRateLimiter, type RateLimiter } from './lib/rate-limiter.ts';

export type TRPCContext = {
  db: DbExecutor;
  userId: string | null;
  profileCache: RequestProfileCache;
};

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  /**
   * Mirror `i18nKey` and `errorCode` from `TRPCError.cause` onto the wire
   * `data` payload so the web client's `resolveTRPCError()` can translate
   * without parsing raw error messages.
   */
  errorFormatter({ shape, error }) {
    const cause = error.cause as { i18nKey?: string; code?: string } | undefined;
    const internal = error.code === 'INTERNAL_SERVER_ERROR';
    const busy = internal && isTransientDatabaseError(error);
    const publicCause = busy
      ? errorCause('server.busy')
      : cause?.i18nKey
        ? cause
        : internal
          ? errorCause('server.unexpected')
          : undefined;
    return {
      ...shape,
      message: internal ? 'Unable to complete this operation. Please try again.' : shape.message,
      data: {
        ...shape.data,
        stack: undefined,
        i18nKey: publicCause?.i18nKey,
        errorCode: publicCause?.code ?? null,
      },
    };
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * Maps domain errors thrown by services to their tRPC equivalents so routers
 * can stay thin and services can throw typed domain errors (NotFoundError)
 * instead of reaching for TRPCError directly.
 *
 * When a `BusinessRuleError` / `InvariantViolationError` carries an
 * `i18nKey` in its `meta`, we forward the whole meta as `cause` on the
 * TRPCError (so the `errorFormatter` can surface it). Otherwise we attach
 * a default `errorCause(...)` for the corresponding bucket.
 */
const domainErrorMapper = t.middleware(async ({ next }) => {
  try {
    const result = await next();
    if (!result.ok && isClosedFinancialPeriodError(result.error)) {
      return { ...result, error: closedPeriodError() };
    }
    return result;
  } catch (err) {
    if (isClosedFinancialPeriodError(err)) throw closedPeriodError();
    if (err instanceof NotFoundError) {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
    }
    if (err instanceof BusinessRuleError) {
      const ctx = err.context as Record<string, unknown> | undefined;
      const cause = ctx && typeof ctx.i18nKey === 'string' ? ctx : errorCause('validation.generic');
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause });
    }
    if (err instanceof InvariantViolationError) {
      const ctx = err.context as Record<string, unknown> | undefined;
      const cause =
        ctx && typeof ctx.i18nKey === 'string' ? ctx : errorCause('domain.invariantViolation');
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause });
    }
    throw err;
  }
});

function closedPeriodError() {
  return new TRPCError({
    code: 'CONFLICT',
    message: 'Financial period is closed; reopen it with a reason before changing it',
    cause: errorCause('financial.periodClosed'),
  });
}

export const publicProcedure = t.procedure.use(domainErrorMapper);

class RequestTxRollback extends Error {
  constructor() {
    super('protectedProcedure: rolling back request transaction after downstream error');
  }
}

/**
 * Authentication + profile-existence guard + RLS boundary.
 *
 * Every protected procedure runs inside a transaction that sets
 * app.current_user_id with SET LOCAL semantics. When the runtime connects as
 * app_user, Postgres RLS becomes a real backstop in addition to explicit
 * userId predicates in application queries.
 */
export const protectedProcedure = t.procedure
  .use(domainErrorMapper)
  .use(async ({ ctx, next, type }) => {
    if (!ctx.userId) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
        cause: errorCause('auth.notAuthenticated'),
      });
    }
    const userId = ctx.userId;

    type NextResult = Awaited<ReturnType<typeof next>>;
    let failed: NextResult | null = null;

    const succeeded = await ctx.db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
        if (type === 'mutation')
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text,0))`);

        const profile = await ctx.profileCache.get(userId, tx);
        if (!profile) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid session',
            cause: errorCause('auth.invalidSession'),
          });
        }

        const result = await next({ ctx: { ...ctx, db: tx, userId: profile.id } });
        if (!result.ok) {
          failed = result;
          throw new RequestTxRollback();
        }
        return result;
      })
      .catch((err: unknown) => {
        if (err instanceof RequestTxRollback) return null;
        throw err;
      });

    if (succeeded) return succeeded;
    if (failed) return failed;
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Request transaction produced no result',
    });
  });

/**
 * Default in-memory rate limiter shared across `rateLimit(...)` call sites
 * that don't pass an explicit instance. Capacity 5, refill 1/s is a
 * conservative default suitable for low-frequency mutations (e.g. paying a
 * bill). Override per-bucket by passing a custom limiter to `rateLimit()`.
 */
export const defaultRateLimiter: RateLimiter = createRateLimiter({
  capacity: 5,
  refillPerSec: 1,
});

/**
 * tRPC middleware factory that enforces a per-user token-bucket rate limit
 * scoped to a logical bucket name (e.g. `'bill.pay'`). Unauthenticated
 * callers share the `'anon'` bucket; chain this AFTER the auth guard on
 * `protectedProcedure` so anon requests get UNAUTHORIZED instead of being
 * throttled at the shared anon key.
 *
 * On rejection, throws `TOO_MANY_REQUESTS` with `errorCause('rateLimited')`
 * so the UI error translator can surface a localized message.
 */
export function rateLimit(bucket: string, limiter: RateLimiter = defaultRateLimiter) {
  return t.middleware(async ({ ctx, next }) => {
    const key = `${ctx.userId ?? 'anon'}:${bucket}`;
    if (!limiter.tryAcquire(key)) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Please try again shortly.',
        cause: errorCause('rateLimited'),
      });
    }
    return next();
  });
}
