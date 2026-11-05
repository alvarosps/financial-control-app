import { userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { bestEffortFxRefresh } from '../lib/fx-refresh.ts';
import { createGuardedServices } from '../lib/service-factory.ts';
import { DailyControlService } from '../services/daily-control.service.ts';
import { DashboardService } from '../services/dashboard.service.ts';
import { MonthClosingService } from '../services/month-closing.service.ts';
import { closingReviewSchema } from '../services/month-closing-checklist.service.ts';
import { MonthOverviewService } from '../services/month-overview.service.ts';
import { protectedProcedure, router } from '../trpc.ts';

export const dashboardRouter = router({
  monthlySummary: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { fxRate } = createGuardedServices(ctx.db);
      await bestEffortFxRefresh(fxRate);
      const service = new DashboardService(ctx.db);
      return service.getMonthlySummary(ctx.userId, input.month, input.year);
    }),

  monthOverview: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
        horizonDays: z.number().int().min(1).max(120).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { fxRate } = createGuardedServices(ctx.db);
      await bestEffortFxRefresh(fxRate);
      return new MonthOverviewService(ctx.db).getOverview(
        ctx.userId,
        input.month,
        input.year,
        input.horizonDays ?? 45,
      );
    }),

  upcomingObligations: protectedProcedure.query(({ ctx }) =>
    new DashboardService(ctx.db).getUpcomingObligations(ctx.userId),
  ),

  upcomingItems: protectedProcedure
    .input(
      z
        .object({
          days: z.number().int().min(1).max(90).default(30),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const service = new DashboardService(ctx.db);
      return service.getUpcomingItems(ctx.userId, input?.days ?? 30);
    }),

  cashFlow: protectedProcedure
    .input(
      z
        .object({
          months: z.number().int().min(1).max(24).default(6),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const { fxRate } = createGuardedServices(ctx.db);
      await bestEffortFxRefresh(fxRate);
      const service = new DashboardService(ctx.db);
      return service.getCashFlow(ctx.userId, input?.months ?? 6);
    }),

  dailyControl: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const service = new DailyControlService(ctx.db);
      return service.getDailyControl(ctx.userId, input.month, input.year);
    }),

  profile: protectedProcedure.query(async ({ ctx }) => {
    const [profile] = await ctx.db
      .select({
        id: userProfiles.id,
        email: userProfiles.email,
        name: userProfiles.name,
        createdAt: userProfiles.createdAt,
      })
      .from(userProfiles)
      .where(eq(userProfiles.id, ctx.userId));
    return profile ?? null;
  }),

  monthStatus: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const service = new MonthClosingService(ctx.db);
      return service.getStatus(ctx.userId, input.month, input.year);
    }),

  closingPreview: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
        review: closingReviewSchema.optional(),
      }),
    )
    .query(({ ctx, input }) =>
      new MonthClosingService(ctx.db).preview(ctx.userId, input.month, input.year, input.review),
    ),

  closeMonth: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
        notes: z.string().max(500).optional(),
        review: closingReviewSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new MonthClosingService(ctx.db);
      return service.closeMonth(ctx.userId, input.month, input.year, input.notes, input.review);
    }),

  reopenMonth: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
        reason: z.string().trim().min(3).max(500),
        revision: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new MonthClosingService(ctx.db);
      return service.reopenMonth(ctx.userId, input.month, input.year, input.reason, input.revision);
    }),
});
