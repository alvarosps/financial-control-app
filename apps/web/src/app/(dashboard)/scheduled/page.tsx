import { HydrateClient, trpc } from '@/lib/trpc/server';
import { ScheduledClient } from './ScheduledClient';

export const dynamic = 'force-dynamic';

export default async function ScheduledPage() {
  await trpc.scheduled.list.prefetch();
  return (
    <HydrateClient>
      <ScheduledClient />
    </HydrateClient>
  );
}
