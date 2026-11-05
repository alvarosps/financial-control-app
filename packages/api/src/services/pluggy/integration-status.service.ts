import type { DbExecutor } from '@fc/db';
import { externalAccounts, externalConnections, externalMovements, integrationJobs } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, count, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { normalizePluggyCard } from './pluggy-normalizer.ts';
import { pluggyTransactionSchema } from './pluggy-types.ts';

const unpublished = (userId: string) => sql`NOT EXISTS (
  SELECT 1 FROM financial_events e WHERE e.user_id=${userId} AND e.source='pluggy'
    AND e.external_id=${externalMovements.externalId}::text
    AND e.source_scope=${externalAccounts.connectionId}::text || ':' || ${externalAccounts.id}::text
) AND COALESCE(${externalMovements.payload}->>'operationType','') <> 'PAGAMENTO_FATURA'`;

export class IntegrationStatusService {
  constructor(private db: DbExecutor) {}
  async list(userId: string) {
    const connections = await this.db
      .select()
      .from(externalConnections)
      .where(eq(externalConnections.userId, userId))
      .orderBy(externalConnections.createdAt);
    const accounts = await this.db
      .select()
      .from(externalAccounts)
      .where(eq(externalAccounts.userId, userId));
    const exceptions = await this.db
      .select({ accountId: externalAccounts.id, count: count() })
      .from(externalMovements)
      .innerJoin(
        externalAccounts,
        and(
          eq(externalAccounts.id, externalMovements.externalAccountId),
          eq(externalAccounts.userId, userId),
          eq(externalAccounts.kind, 'CREDIT'),
        ),
      )
      .where(
        and(
          eq(externalMovements.userId, userId),
          isNull(externalMovements.retractedAt),
          unpublished(userId),
        ),
      )
      .groupBy(externalAccounts.id);
    return Promise.all(
      connections.map(async (c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        lastFetchedAt: c.lastFetchedAt,
        sourceUpdatedAt: c.sourceUpdatedAt,
        errorCode: c.errorCode,
        accounts: accounts
          .filter((a) => a.connectionId === c.id)
          .map((a) => ({
            id: a.id,
            name: a.name,
            kind: a.kind,
            currency: a.currency,
            accountId: a.accountId,
            unresolvedCardEvidence: exceptions.find((e) => e.accountId === a.id)?.count ?? 0,
          })),
        jobs: await this.db
          .select({
            id: integrationJobs.id,
            status: integrationJobs.status,
            errorCode: integrationJobs.errorCode,
            attempts: integrationJobs.attempts,
            nextAttemptAt: integrationJobs.nextAttemptAt,
          })
          .from(integrationJobs)
          .where(and(eq(integrationJobs.userId, userId), eq(integrationJobs.connectionId, c.id)))
          .orderBy(desc(integrationJobs.createdAt), desc(integrationJobs.id))
          .limit(10),
      })),
    );
  }
  async cardExceptions(userId: string, input: { externalAccountId: string; cursor?: string }) {
    const [account] = await this.db
      .select()
      .from(externalAccounts)
      .where(
        and(
          eq(externalAccounts.userId, userId),
          eq(externalAccounts.id, input.externalAccountId),
          eq(externalAccounts.kind, 'CREDIT'),
        ),
      );
    if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Card source not found' });
    const rows = await this.db
      .select({ movement: externalMovements })
      .from(externalMovements)
      .innerJoin(
        externalAccounts,
        and(
          eq(externalAccounts.id, externalMovements.externalAccountId),
          eq(externalAccounts.userId, userId),
        ),
      )
      .where(
        and(
          eq(externalMovements.userId, userId),
          eq(externalMovements.externalAccountId, account.id),
          isNull(externalMovements.retractedAt),
          unpublished(userId),
          input.cursor ? lt(externalMovements.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(externalMovements.id))
      .limit(51);
    return {
      items: rows.slice(0, 50).map(({ movement }) => {
        const raw = pluggyTransactionSchema.parse(movement.payload);
        const result = normalizePluggyCard(raw, account.accountId);
        return {
          id: movement.id,
          description: raw.description,
          date: raw.date.slice(0, 10),
          reason: result.kind === 'review' ? result.reason : 'awaiting_processing',
        };
      }),
      nextCursor: rows.length > 50 ? rows[49].movement.id : null,
    };
  }
}
