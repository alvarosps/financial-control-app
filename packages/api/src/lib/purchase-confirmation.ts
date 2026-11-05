import type { DbExecutor } from '@fc/db';
import { financialEventRevisions, financialEvents } from '@fc/db';
import type { EventConfirmation } from '@fc/shared';
import { and, eq } from 'drizzle-orm';

export async function loadPurchaseConfirmation(
  db: DbExecutor,
  userId: string,
  observationId: string,
  replacement?: { eventId: string; confirmation: EventConfirmation },
): Promise<EventConfirmation> {
  const revisions = await db
    .select({ eventId: financialEvents.id, data: financialEventRevisions.data })
    .from(financialEvents)
    .innerJoin(
      financialEventRevisions,
      and(
        eq(financialEventRevisions.eventId, financialEvents.id),
        eq(financialEventRevisions.sourceVersion, financialEvents.currentVersion),
        eq(financialEventRevisions.userId, userId),
      ),
    )
    .where(
      and(eq(financialEvents.userId, userId), eq(financialEvents.observationId, observationId)),
    );
  const confirmations = revisions
    .filter((revision) => revision.eventId !== replacement?.eventId)
    .map((revision) => revision.data.confirmation);
  if (replacement) confirmations.push(replacement.confirmation);
  return (
    (['retracted', 'posted', 'pending', 'observed'] as const).find((state) =>
      confirmations.includes(state),
    ) ?? 'observed'
  );
}
