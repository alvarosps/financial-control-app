import { logger } from './logger.ts';

export type OperationOutcome = 'success' | 'error';

export type OperationTelemetryContext = {
  suppress?: boolean;
};

type OperationEvent = {
  event: string;
  outcome: OperationOutcome;
  durationMs: number;
  errorCode?: string;
} & Record<string, boolean | number | string | undefined>;

export function startOperationTimer(now: () => number = () => performance.now()) {
  const startedAt = now();

  return {
    elapsedMs: () => Math.round((now() - startedAt) * 100) / 100,
  };
}

export function operationErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'unknown';
  }

  const candidate = error as { code?: unknown; name?: unknown };
  if (typeof candidate.code === 'string') {
    return candidate.code;
  }
  if (typeof candidate.name === 'string') {
    return candidate.name;
  }
  return 'unknown';
}

export async function measureOperation<T>(
  event: string,
  fields: Record<string, boolean | number | string | undefined>,
  execute: () => Promise<T>,
  context?: OperationTelemetryContext,
): Promise<T> {
  const timer = startOperationTimer();
  try {
    const result = await execute();
    if (!context?.suppress) {
      const log: OperationEvent = {
        event,
        outcome: 'success',
        durationMs: timer.elapsedMs(),
        ...fields,
      };
      logger.info(log, event);
    }
    return result;
  } catch (error) {
    if (!context?.suppress) {
      const log: OperationEvent = {
        event,
        outcome: 'error',
        durationMs: timer.elapsedMs(),
        errorCode: operationErrorCode(error),
        ...fields,
      };
      logger.error(log, event);
    }
    throw error;
  }
}
