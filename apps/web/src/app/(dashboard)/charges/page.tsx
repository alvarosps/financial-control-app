import { resolveMonthYear } from '@/lib/month-params';
import { HydrateClient, trpc } from '@/lib/trpc/server';
import { ChargesClient } from './ChargesClient';

export const dynamic = 'force-dynamic';

export default async function ChargesPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const { month, year } = resolveMonthYear(await searchParams);
  await trpc.charges.list.prefetch({ month, year });
  return (
    <HydrateClient>
      <ChargesClient initialMonth={month} initialYear={year} />
    </HydrateClient>
  );
}
