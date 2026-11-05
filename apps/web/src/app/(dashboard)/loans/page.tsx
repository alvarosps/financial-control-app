import { HydrateClient, trpc } from '@/lib/trpc/server';
import { LoansClient } from './LoansClient';

export const dynamic = 'force-dynamic';

export default async function LoansPage() {
  await trpc.loan.list.prefetch();
  return (
    <HydrateClient>
      <LoansClient />
    </HydrateClient>
  );
}
