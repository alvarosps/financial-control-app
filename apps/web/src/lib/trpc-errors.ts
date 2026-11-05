import type { AppRouter } from '@fc/api';
import { TRPCClientError } from '@trpc/client';

/**
 * Shape of the callable returned by `useTranslations()` from `next-intl`.
 * Accepting this minimal contract lets tests pass a stub without pulling
 * the whole i18n runtime into non-React scope.
 */
type TKeyFn = (key: string, values?: Record<string, string | number | Date>) => string;

/**
 * Resolves a thrown tRPC error into a user-facing string.
 *
 * Contract:
 *  - If `err` is a `TRPCClientError<AppRouter>` with `data.i18nKey`, we call
 *    `t(data.i18nKey)`. `next-intl` throws if the key is missing; we fall
 *    back to `err.message` in that case so the user still sees something.
 *  - Otherwise we return `err.message` (TRPCClientError) or the `Error`
 *    message, or a generic "Unknown error" sentinel.
 *
 * Matches the server-side `errorFormatter` in `packages/api/src/trpc.ts`
 * which writes `i18nKey` + `errorCode` onto the wire `data` payload.
 */
export function resolveTRPCError(err: unknown, t: TKeyFn): string {
  if (err instanceof TRPCClientError) {
    const data = (err as TRPCClientError<AppRouter>).data as { i18nKey?: string } | null;
    if (data?.i18nKey) {
      try {
        return t(data.i18nKey);
      } catch {
        /* fallthrough to raw message */
      }
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Unknown error';
}
