import { HydrateClient, trpc } from '@/lib/trpc/server';
import { CategoriesClient } from './CategoriesClient';

export const dynamic = 'force-dynamic';

export default async function CategoriesPage() {
  await trpc.category.list.prefetch();
  return (
    <HydrateClient>
      <CategoriesClient />
    </HydrateClient>
  );
}
