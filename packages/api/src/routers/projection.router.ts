import { bestEffortFxRefresh } from '../lib/fx-refresh.ts';
import { createGuardedServices } from '../lib/service-factory.ts';
import { ProjectionService } from '../services/projection.service.ts';
import { protectedProcedure, router } from '../trpc.ts';

export const projectionRouter = router({
  get12Months: protectedProcedure.query(async ({ ctx }) => {
    const { guard, fxRate } = createGuardedServices(ctx.db);
    // Once-per-day USD→BRL refresh; cheap on the fast path and never throws.
    await bestEffortFxRefresh(fxRate);
    const service = new ProjectionService(ctx.db, guard);
    return service.get12MonthProjection(ctx.userId);
  }),
});
