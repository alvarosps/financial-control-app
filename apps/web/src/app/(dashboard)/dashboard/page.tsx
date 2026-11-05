import { resolveMonthYear } from '@/lib/month-params';
import { HydrateClient, trpc } from '@/lib/trpc/server';
import { DashboardClient } from './DashboardClient';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const { month, year } = resolveMonthYear(await searchParams);

  await Promise.allSettled([
    trpc.dashboard.monthlySummary.prefetch({ month, year }),
    trpc.dashboard.monthStatus.prefetch({ month, year }),
    trpc.dashboard.monthOverview.prefetch({ month, year }),
    trpc.dashboard.upcomingItems.prefetch({ days: 30 }),
    trpc.dashboard.cashFlow.prefetch({ months: 6 }),
    trpc.account.walletCashSeries.prefetch({ days: 30 }),
    trpc.income.autoCreditDue.prefetch(),
  ]);

  return (
    <HydrateClient>
      <DashboardClient month={month} year={year} />
    </HydrateClient>
  );
}
