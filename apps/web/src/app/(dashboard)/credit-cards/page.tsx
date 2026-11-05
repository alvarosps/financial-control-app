import { HydrateClient, trpc } from '@/lib/trpc/server';
import { CreditCardsClient } from './CreditCardsClient';

export const dynamic = 'force-dynamic';

export default async function CreditCardsPage() {
  await Promise.all([
    trpc.creditCard.getBillSummary.prefetch(),
    trpc.creditCard.listConfigs.prefetch(),
  ]);
  return (
    <HydrateClient>
      <CreditCardsClient />
    </HydrateClient>
  );
}
