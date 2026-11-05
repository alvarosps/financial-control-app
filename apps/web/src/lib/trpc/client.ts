import type { AppRouter } from '@fc/api';
import { type CreateTRPCReact, createTRPCReact } from '@trpc/react-query';

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

type TRPCUtils = ReturnType<typeof trpc.useUtils>;

/**
 * Invalidate every dashboard query that derives from settled state (mark-paid /
 * undo across loans, income, charges, cards). Keep this in sync whenever a new
 * dashboard query starts depending on per-occurrence paid state so settling
 * from any feature page refreshes the dashboard.
 */
export function invalidateDashboard(utils: TRPCUtils): void {
  utils.dashboard.upcomingItems.invalidate();
  utils.dashboard.monthlySummary.invalidate();
  utils.dashboard.dailyControl.invalidate();
  utils.dashboard.monthStatus.invalidate();
  utils.dashboard.monthOverview.invalidate();
  utils.dashboard.cashFlow.invalidate();
}
