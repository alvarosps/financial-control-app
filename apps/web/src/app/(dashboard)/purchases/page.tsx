import { daysAgoSaoPauloISO } from '@/lib/dates';
import { HydrateClient, trpc } from '@/lib/trpc/server';
import { PurchasesClient } from './PurchasesClient';

export const dynamic = 'force-dynamic';
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ card?: string }>;
}) {
  const { card } = await searchParams;
  const cardAccountId =
    card && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(card)
      ? card
      : undefined;
  const initialDay = daysAgoSaoPauloISO(0);
  await trpc.purchaseInbox.list.prefetchInfinite({
    fromDate: daysAgoSaoPauloISO(6),
    toDate: initialDay,
    limit: 20,
    cardAccountId,
  });
  return (
    <HydrateClient>
      <PurchasesClient initialDay={initialDay} initialCardId={cardAccountId} />
    </HydrateClient>
  );
}
