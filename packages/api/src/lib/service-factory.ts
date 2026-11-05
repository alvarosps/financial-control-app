import type { DbExecutor } from '@fc/db';

import { FxRateService } from '../services/fx-rate.service.ts';
import { MaterializationGuard } from '../services/materialization-guard.service.ts';
import { MaterializerService } from '../services/materializer.service.ts';

export function createGuardedServices(db: DbExecutor) {
  const materializer = new MaterializerService(db);
  const guard = new MaterializationGuard(db);
  const fxRate = new FxRateService(db);
  return { materializer, guard, fxRate, db };
}
