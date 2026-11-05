import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { notFound } from 'next/navigation';
import { trpc as trpcReact } from '@/lib/trpc/client';
import { getQueryClient, trpc } from '@/lib/trpc/server';
import { LoanDetailClient } from './LoanDetailClient';

export const dynamic = 'force-dynamic';

export default async function LoanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loan = await trpc.loan.getById({ accountId: id }).catch(() => null);
  if (!loan) notFound();

  const queryClient = getQueryClient();
  queryClient.setQueryData(getQueryKey(trpcReact.loan.getById, { accountId: id }, 'query'), loan);
  await trpc.account.list.prefetch();

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LoanDetailClient accountId={id} />
    </HydrationBoundary>
  );
}
