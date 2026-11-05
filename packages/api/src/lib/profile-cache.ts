import type { DbExecutor } from '@fc/db';
import { userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';

export type RequestProfileCache = {
  /**
   * Resolve profile existence for `userId`, memoized per request. The optional
   * db override lets protectedProcedure route the lookup through the request
   * transaction where app.current_user_id is set.
   */
  get(userId: string, db?: DbExecutor): Promise<{ id: string } | null>;
};

/**
 * Request-scoped cache for the `protectedProcedure` profile-existence guard.
 *
 * One instance is created per tRPC request in the context factory so that
 * multiple procedure calls within the same batched request share a single DB
 * round-trip. The cache intentionally does not span requests — it must not
 * outlive the request because the underlying profile can be deleted between
 * requests.
 */
export function createRequestProfileCache(defaultDb: DbExecutor): RequestProfileCache {
  const memo = new Map<string, Promise<{ id: string } | null>>();
  return {
    get(userId, db = defaultDb) {
      const hit = memo.get(userId);
      if (hit) return hit;
      const promise = db
        .select({ id: userProfiles.id })
        .from(userProfiles)
        .where(eq(userProfiles.id, userId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      memo.set(userId, promise);
      return promise;
    },
  };
}
