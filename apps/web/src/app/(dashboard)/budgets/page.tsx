import { resolveMonthYear } from '@/lib/month-params';
import { HydrateClient, trpc } from '@/lib/trpc/server';
import { BudgetsClient } from './BudgetsClient';

export const dynamic = 'force-dynamic';
export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const { month, year } = resolveMonthYear(await searchParams);
  await trpc.budget.list.prefetch({ month, year });
  return (
    <HydrateClient>
      <BudgetsClient initialMonth={month} initialYear={year} />
    </HydrateClient>
  );
}
