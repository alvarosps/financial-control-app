import type { DbExecutor } from '@fc/db';
import { accounts, externalAccounts, externalConnections } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { runWithMaterializationLock } from '../../lib/materialization-lock.ts';
import { AuditService } from '../audit.service.ts';
import { IntegrationJobService } from './integration-job.service.ts';
import type { PluggyClient } from './pluggy-client.ts';

const grantsSchema = z
  .array(z.object({ userId: z.guid(), itemId: z.guid() }).strict())
  .max(100)
  .refine((rows) => new Set(rows.map((row) => row.itemId)).size === rows.length);
export function parsePersonalItemGrants(raw: string | undefined) {
  try {
    return grantsSchema.parse(JSON.parse(raw ?? '[]'));
  } catch {
    throw new Error('PLUGGY_PERSONAL_ITEMS_INVALID');
  }
}
export class PluggyConnectionService {
  constructor(
    private db: DbExecutor,
    private client: PluggyClient,
    private grants: { userId: string; itemId: string }[],
  ) {}

  private requireGrant(userId: string, itemId: string) {
    if (
      !grantsSchema.safeParse(this.grants).success ||
      !this.grants.some((grant) => grant.userId === userId && grant.itemId === itemId)
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Personal connection is not authorized' });
    }
  }
  async attach(userId: string, itemId: string) {
    this.requireGrant(userId, itemId);
    const item = await this.client.getItem(itemId);
    if (item.connector.id !== 200)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Personal MeuPluggy connector required',
      });
    return this.db.transaction(async (tx) => {
      await tx
        .insert(externalConnections)
        .values({ userId, itemId, name: item.connector.name })
        .onConflictDoNothing();
      const [connection] = await tx
        .select()
        .from(externalConnections)
        .where(and(eq(externalConnections.userId, userId), eq(externalConnections.itemId, itemId)))
        .for('update');
      if (!connection)
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Connection already assigned' });
      await new IntegrationJobService(tx).enqueue(userId, connection.id, 'initial');
      return connection;
    });
  }
  async mapAccount(userId: string, externalId: string, accountId: string) {
    return runWithMaterializationLock(this.db, userId, async ({ db: tx }) => {
      const [external] = await tx
        .select()
        .from(externalAccounts)
        .where(and(eq(externalAccounts.userId, userId), eq(externalAccounts.id, externalId)))
        .for('update');
      const [account] = await tx
        .select()
        .from(accounts)
        .where(
          and(eq(accounts.userId, userId), eq(accounts.id, accountId), eq(accounts.isActive, true)),
        );
      if (!external || !account)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
      if (external.accountId && external.accountId !== accountId)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Existing mapping must retain its financial history',
        });
      if (
        external.currency !== account.currency ||
        (external.kind === 'CREDIT'
          ? account.type !== 'credit_card'
          : !['checking', 'savings'].includes(account.type))
      ) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Account type or currency differs' });
      }
      await tx
        .update(externalAccounts)
        .set({ accountId })
        .where(and(eq(externalAccounts.userId, userId), eq(externalAccounts.id, externalId)));
      await new AuditService(tx).log(
        userId,
        'map_external_account',
        'external_account',
        external.id,
        { accountId: external.accountId },
        { accountId },
      );
      if (external.kind === 'CREDIT')
        await new IntegrationJobService(tx).enqueue(
          userId,
          external.connectionId,
          `mapping:${external.id}:${accountId}`,
          { publishAccountId: external.id },
        );
    });
  }
  async setPaused(userId: string, connectionId: string, paused: boolean) {
    return this.db.transaction(async (tx) => {
      const [connection] = await tx
        .select()
        .from(externalConnections)
        .where(
          and(eq(externalConnections.userId, userId), eq(externalConnections.id, connectionId)),
        )
        .for('update');
      if (!connection) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
      if (!paused) {
        this.requireGrant(userId, connection.itemId);
        const item = await this.client.getItem(connection.itemId);
        if (item.connector.id !== 200 || item.status !== 'UPDATED')
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Renew the personal connection authorization',
          });
      }
      await tx
        .update(externalConnections)
        .set({ status: paused ? 'paused' : 'active' })
        .where(
          and(eq(externalConnections.userId, userId), eq(externalConnections.id, connectionId)),
        );
      await new AuditService(tx).log(
        userId,
        paused ? 'pause_integration' : 'resume_integration',
        'external_connection',
        connectionId,
      );
    });
  }
  async requestSync(userId: string, connectionId: string) {
    const [connection] = await this.db
      .select()
      .from(externalConnections)
      .where(and(eq(externalConnections.userId, userId), eq(externalConnections.id, connectionId)));
    if (!connection) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
    if (connection.status !== 'active')
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Connection is paused' });
    this.requireGrant(userId, connection.itemId);
    const key = await this.db.execute(
      sql`SELECT floor(extract(epoch FROM clock_timestamp()) / 300)::text AS window`,
    );
    return new IntegrationJobService(this.db).enqueue(
      userId,
      connectionId,
      `manual:${key[0].window}`,
    );
  }
}
