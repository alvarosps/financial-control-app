import {
  BudgetService,
  budgetCreateSchema,
  budgetPeriodSchema,
  budgetUpdateSchema,
} from '../services/budget.service.ts';
import { protectedProcedure, router } from '../trpc.ts';

export const budgetRouter = router({
  list: protectedProcedure
    .input(budgetPeriodSchema)
    .query(({ ctx, input }) => new BudgetService(ctx.db).list(ctx.userId, input)),
  create: protectedProcedure
    .input(budgetCreateSchema)
    .mutation(({ ctx, input }) => new BudgetService(ctx.db).create(ctx.userId, input)),
  update: protectedProcedure
    .input(budgetUpdateSchema)
    .mutation(({ ctx, input }) => new BudgetService(ctx.db).update(ctx.userId, input)),
});
