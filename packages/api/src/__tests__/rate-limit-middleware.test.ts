import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { createRequestProfileCache } from '../lib/profile-cache.ts';
import { createRateLimiter } from '../lib/rate-limiter.ts';
import { withRollback } from '../test/with-rollback.ts';
import { createCallerFactory, publicProcedure, rateLimit, router } from '../trpc.ts';

/**
 * Integration-style proof: the `rateLimit` middleware, when chained onto a
 * real tRPC procedure, rejects the (capacity + 1)th call with
 * `TOO_MANY_REQUESTS` and the i18n cause marker. We use a fresh limiter
 * (not `defaultRateLimiter`) to keep the test hermetic.
 *
 * The caller is built with a real `TRPCContext` (real test `db` + real
 * `profileCache`) inside `withRollback`. The rateLimit chain only reads
 * `ctx.userId` and never queries the DB, so the transaction rolls back with
 * zero writes; the real fields exist purely to satisfy the production context
 * type without casting.
 */
describe('rateLimit middleware', () => {
  it('rejects the (capacity + 1)th call with TOO_MANY_REQUESTS and i18nKey cause', async () => {
    await withRollback(async (db) => {
      const limiter = createRateLimiter({ capacity: 5, refillPerSec: 1 });

      const testRouter = router({
        ping: publicProcedure.use(rateLimit('bill.pay', limiter)).query(() => 'pong'),
      });

      const createCaller = createCallerFactory(testRouter);
      const caller = createCaller({
        db,
        userId: 'user-1',
        profileCache: createRequestProfileCache(db),
      });

      for (let i = 0; i < 5; i++) {
        await expect(caller.ping()).resolves.toBe('pong');
      }

      await expect(caller.ping()).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      });

      // Re-run once more to capture the error object and assert on its cause.
      try {
        await caller.ping();
        throw new Error('expected rate-limit rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(TRPCError);
        const trpcErr = err as TRPCError;
        expect(trpcErr.code).toBe('TOO_MANY_REQUESTS');
        expect(trpcErr.cause).toMatchObject({
          i18nKey: 'errors.rateLimited',
          code: 'rateLimited',
        });

        // Wire-contract: the router's `errorFormatter` mirrors `i18nKey` +
        // `errorCode` onto `data` so the browser resolver can translate.
        // `_def._config.errorFormatter` is part of tRPC's typed Router surface.
        const shape = testRouter._def._config.errorFormatter({
          error: trpcErr,
          type: 'query',
          path: 'ping',
          input: undefined,
          ctx: undefined,
          shape: {
            message: trpcErr.message,
            code: -32029,
            data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 },
          },
        });
        expect(shape.data).toMatchObject({
          i18nKey: 'errors.rateLimited',
          errorCode: 'rateLimited',
        });
      }
    });
  });

  it('keys buckets per user so two users do not share the limit', async () => {
    await withRollback(async (db) => {
      const limiter = createRateLimiter({ capacity: 2, refillPerSec: 1 });

      const testRouter = router({
        ping: publicProcedure.use(rateLimit('bill.pay', limiter)).query(() => 'pong'),
      });

      const createCaller = createCallerFactory(testRouter);
      const callerA = createCaller({
        db,
        userId: 'user-a',
        profileCache: createRequestProfileCache(db),
      });
      const callerB = createCaller({
        db,
        userId: 'user-b',
        profileCache: createRequestProfileCache(db),
      });

      // Drain A.
      await callerA.ping();
      await callerA.ping();
      await expect(callerA.ping()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

      // B is untouched.
      await expect(callerB.ping()).resolves.toBe('pong');
      await expect(callerB.ping()).resolves.toBe('pong');
      await expect(callerB.ping()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    });
  });
});
