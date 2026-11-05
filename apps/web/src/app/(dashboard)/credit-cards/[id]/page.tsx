import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { notFound } from 'next/navigation';
import { currentMonthYear } from '@/lib/month-params';
import { trpc as trpcReact } from '@/lib/trpc/client';
import { getQueryClient, trpc } from '@/lib/trpc/server';
import { CreditCardDetailClient } from './CreditCardDetailClient';

export const dynamic = 'force-dynamic';

export default async function CreditCardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const account = await trpc.account.getById({ id }).catch(() => null);
  if (!account) notFound();

  const queryClient = getQueryClient();
  queryClient.setQueryData(getQueryKey(trpcReact.account.getById, { id }, 'query'), account);

  await Promise.all([
    trpc.creditCard.getConfig.prefetch({ accountId: id }),
    trpc.creditCard.getBillHistory.prefetch({ cardAccountId: id }),
    trpc.account.list.prefetch(),
    trpc.scheduled.list.prefetch(),
    trpc.category.list.prefetch(),
  ]);

  const { month, year } = currentMonthYear();

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <CreditCardDetailClient cardId={id} initialMonth={month} initialYear={year} />
    </HydrationBoundary>
  );
}
