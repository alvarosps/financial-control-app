import type { TRPCError } from '@trpc/server';
import { logger } from './logger.ts';
import { getPostgresErrorCode } from './pg-errors.ts';

export function reportTRPCError({
  error,
  path,
  type,
}: {
  error: TRPCError;
  path?: string;
  type: string;
}) {
  if (error.code !== 'INTERNAL_SERVER_ERROR' && error.code !== 'TIMEOUT') return;
  logger.error(
    {
      event: 'trpc.error',
      path,
      type,
      trpcCode: error.code,
      sqlState: getPostgresErrorCode(error),
    },
    'tRPC request failed',
  );
}
