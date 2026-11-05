import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { notFound } from 'next/navigation';
import { currentMonthYear } from '@/lib/server/current-month';
import { trpc as trpcReact } from '@/lib/trpc/client';
import { getQueryClient, trpc } from '@/lib/trpc/server';
import { FamilyLoanDetailClient } from './FamilyLoanDetailClient';

export const dynamic = 'force-dynamic';

export default async function FamilyLoanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { month, year } = currentMonthYear();
  const familyLoan = await trpc.familyLoan.getById({ configId: id }).catch(() => null);
  if (!familyLoan) notFound();

  const queryClient = getQueryClient();
  queryClient.setQueryData(
    getQueryKey(trpcReact.familyLoan.getById, { configId: id }, 'query'),
    familyLoan,
  );

  await Promise.all([
    trpc.familyLoan.getMonthlyTotal.prefetch({ configId: id, month, year }),
    trpc.familyLoan.getLedger.prefetch({ configId: id, month, year }),
    trpc.familyLoan.get12MonthProjection.prefetch({ configId: id, month, year }),
    trpc.familyLoan.listItems.prefetch({ configId: id, domainType: 'family_loan_discount' }),
    trpc.familyLoan.listItems.prefetch({ configId: id, domainType: 'family_loan_installment' }),
    trpc.familyLoan.listItems.prefetch({ configId: id, domainType: 'family_loan_fixed_charge' }),
    trpc.familyLoan.listItems.prefetch({ configId: id, domainType: 'family_loan_expense' }),
    trpc.account.list.prefetch(),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <FamilyLoanDetailClient configId={id} initialMonth={month} initialYear={year} />
    </HydrationBoundary>
  );
}
