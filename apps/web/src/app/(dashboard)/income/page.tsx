import { HydrateClient, trpc } from '@/lib/trpc/server';
import { IncomeClient } from './IncomeClient';

export const dynamic = 'force-dynamic';

export default async function IncomePage() {
  await trpc.income.list.prefetch();
  return (
    <HydrateClient>
      <IncomeClient />
    </HydrateClient>
  );
}
