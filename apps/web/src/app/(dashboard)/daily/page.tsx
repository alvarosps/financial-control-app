import { resolveMonthYear } from '@/lib/month-params';
import { HydrateClient, trpc } from '@/lib/trpc/server';
import { DailyClient } from './DailyClient';

export const dynamic = 'force-dynamic';

export default async function DailyControlPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const { month, year } = resolveMonthYear(await searchParams);
  await trpc.dashboard.dailyControl.prefetch({ month, year });
  return (
    <HydrateClient>
      <DailyClient initialMonth={month} initialYear={year} />
    </HydrateClient>
  );
}
