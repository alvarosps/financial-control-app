import { HydrateClient, trpc } from '@/lib/trpc/server';
import { ProjectionClient } from './ProjectionClient';

export const dynamic = 'force-dynamic';

export default async function ProjectionPage() {
  await trpc.projection.get12Months.prefetch();
  return (
    <HydrateClient>
      <ProjectionClient />
    </HydrateClient>
  );
}
