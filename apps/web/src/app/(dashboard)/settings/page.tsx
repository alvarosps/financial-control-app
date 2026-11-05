import { HydrateClient, trpc } from '@/lib/trpc/server';
import { SettingsClient } from './SettingsClient';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await trpc.dashboard.profile.prefetch();
  return (
    <HydrateClient>
      <SettingsClient />
    </HydrateClient>
  );
}
