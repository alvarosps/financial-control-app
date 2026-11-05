import { HydrateClient, trpc } from '@/lib/trpc/server';
import { AuditLogClient } from './AuditLogClient';

export const dynamic = 'force-dynamic';

export default async function AuditLogPage() {
  await trpc.auditLog.list.prefetch({ entityType: undefined, page: 1, pageSize: 25 });
  return (
    <HydrateClient>
      <AuditLogClient />
    </HydrateClient>
  );
}
