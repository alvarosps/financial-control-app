import { z } from 'zod';
import { MonthlySpendingService } from '../services/monthly-spending.service.ts';
import { protectedProcedure, router } from '../trpc.ts';

export const monthlySpendingRouter = router({
  get: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const service = new MonthlySpendingService(ctx.db);
      return service.getMonthlySpending(ctx.userId, input.month, input.year);
    }),
});
