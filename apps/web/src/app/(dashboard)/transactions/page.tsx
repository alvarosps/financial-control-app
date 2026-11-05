import { resolveMonthYear } from '@/lib/month-params';
import { HydrateClient, trpc } from '@/lib/trpc/server';
import { TransactionsClient } from './TransactionsClient';

export const dynamic = 'force-dynamic';

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const { month, year } = resolveMonthYear(await searchParams);
  await Promise.all([
    trpc.transaction.list.prefetch({ month, year, accountId: undefined }),
    trpc.account.list.prefetch(),
    trpc.category.list.prefetch(),
  ]);
  return (
    <HydrateClient>
      <TransactionsClient initialMonth={month} initialYear={year} />
    </HydrateClient>
  );
}
