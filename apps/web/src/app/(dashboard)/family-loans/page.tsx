import { currentMonthYear } from '@/lib/server/current-month';
import { HydrateClient, trpc } from '@/lib/trpc/server';
import { FamilyLoansClient } from './FamilyLoansClient';

export const dynamic = 'force-dynamic';

export default async function FamilyLoansPage() {
  const { month, year } = currentMonthYear();

  await trpc.familyLoan.listWithTotals.prefetch({ month, year });

  return (
    <HydrateClient>
      <FamilyLoansClient month={month} year={year} />
    </HydrateClient>
  );
}
