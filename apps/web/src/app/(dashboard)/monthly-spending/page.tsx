import { resolveMonthYear } from '@/lib/month-params';
import { HydrateClient, trpc } from '@/lib/trpc/server';
import { MonthlySpendingClient } from './MonthlySpendingClient';

export const dynamic = 'force-dynamic';

export default async function MonthlySpendingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const { month, year } = resolveMonthYear(await searchParams);
  await trpc.monthlySpending.get.prefetch({ month, year });
  return (
    <HydrateClient>
      <MonthlySpendingClient initialMonth={month} initialYear={year} />
    </HydrateClient>
  );
}
