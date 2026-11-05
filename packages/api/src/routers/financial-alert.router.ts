import { budgetPeriodSchema } from '../services/budget.service.ts';
import {
  FinancialAlertService,
  financialAlertStateSchema,
} from '../services/financial-alert.service.ts';
import { protectedProcedure, router } from '../trpc.ts';

export const financialAlertRouter = router({
  list: protectedProcedure
    .input(budgetPeriodSchema.optional())
    .query(({ ctx, input }) => new FinancialAlertService(ctx.db).list(ctx.userId, input)),
  refresh: protectedProcedure
    .input(budgetPeriodSchema.optional())
    .mutation(({ ctx, input }) => new FinancialAlertService(ctx.db).refresh(ctx.userId, input)),
  setState: protectedProcedure
    .input(financialAlertStateSchema)
    .mutation(({ ctx, input }) => new FinancialAlertService(ctx.db).setState(ctx.userId, input)),
});
