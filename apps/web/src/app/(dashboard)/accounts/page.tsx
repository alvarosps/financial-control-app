import { HydrateClient, trpc } from '@/lib/trpc/server';
import { AccountsClient } from './AccountsClient';

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  await Promise.allSettled([
    trpc.account.walletsOverview.prefetch(),
    trpc.income.autoCreditDue.prefetch(),
  ]);
  return (
    <HydrateClient>
      <AccountsClient />
    </HydrateClient>
  );
}
