import type { FxRateService } from '../services/fx-rate.service.ts';
import { logger } from './logger.ts';

/**
 * Refresh the USD-to-BRL rate on a best-effort basis without rejecting the
 * current request. A failure is logged and the cached stale-but-usable rate
 * remains available.
 */
export async function bestEffortFxRefresh(
  fxRate: Pick<FxRateService, 'refreshIfStale'>,
): Promise<void> {
  try {
    await fxRate.refreshIfStale(new Date());
  } catch (error) {
    logger.warn({ err: error }, 'Best-effort FX refresh failed; continuing with cached rate');
  }
}
