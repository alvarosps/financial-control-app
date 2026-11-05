import { createHash } from 'node:crypto';
import type { DbExecutor } from '@fc/db';
import { externalAccounts, externalBills, externalConnections, externalMovements } from '@fc/db';
import { Money } from '@fc/domain';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { runWithMaterializationLock } from '../../lib/materialization-lock.ts';
import {
  assertIntegrationRole,
  IntegrationJobService,
  type IntegrationLease,
} from './integration-job.service.ts';
import { PluggyCardReconciliationService } from './pluggy-card-reconciliation.service.ts';
import { type PluggyClient, PluggyError, validatePluggyCursor } from './pluggy-client.ts';
import { type PluggyTransaction, pluggyTransactionFiltersSchema } from './pluggy-types.ts';
import { integrationPayloadSchema } from './pluggy-webhook.service.ts';

const checkpointSchema = z.object({
  phase: z.enum(['item', 'accounts', 'bills', 'transactions']).default('item'),
  accountIds: z.array(z.guid()).max(500).default([]),
  index: z.number().int().min(0).max(500).default(0),
  filters: pluggyTransactionFiltersSchema.default({}),
  windowFilters: pluggyTransactionFiltersSchema.default({}),
  refreshingPending: z.boolean().default(false),
  cursor: z.string().max(16_384).nullable().default(null),
  seen: z.array(z.string().length(64)).max(1000).default([]),
  sourceUpdatedAt: z.string().nullable().default(null),
  foundIds: z.array(z.guid()).max(500).default([]),
  publishAfter: z.guid().nullable().default(null),
  createdFilters: pluggyTransactionFiltersSchema.default({}),
  createdSweepDone: z.boolean().default(false),
  initialAccountIds: z.array(z.guid()).max(500).default([]),
  absenceVersions: z.record(z.guid(), z.number().int()).default({}),
  sweepStartedAt: z.string().datetime().nullable().default(null),
});
type Checkpoint = z.infer<typeof checkpointSchema>;

function cursorHash(accountId: string, checkpoint: Checkpoint, cursor: string) {
  const url = new URL(validatePluggyCursor(accountId, checkpoint.filters, cursor));
  url.searchParams.sort();
  return createHash('sha256').update(url.toString()).digest('hex');
}
export class PluggySyncService {
  constructor(
    private db: DbExecutor,
    private client: PluggyClient,
  ) {}

  private owned<T>(userId: string, work: (db: DbExecutor) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
      return work(tx);
    });
  }
  private async storeMovement(
    db: DbExecutor,
    userId: string,
    accountId: string,
    payload: PluggyTransaction,
  ) {
    const contentHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const sourceUpdatedAt = new Date(payload.updatedAt);
    const [old] = await db
      .select()
      .from(externalMovements)
      .where(
        and(
          eq(externalMovements.userId, userId),
          eq(externalMovements.externalAccountId, accountId),
          eq(externalMovements.externalId, payload.id),
        ),
      )
      .for('update');
    if (old) {
      if (
        (old.contentHash === contentHash && !old.retractedAt) ||
        old.sourceUpdatedAt > sourceUpdatedAt
      )
        return;
      await db
        .update(externalMovements)
        .set({
          payload,
          contentHash,
          sourceUpdatedAt,
          version: old.version + 1,
          fetchedAt: new Date(),
          retractedAt: null,
        })
        .where(and(eq(externalMovements.userId, userId), eq(externalMovements.id, old.id)));
    } else {
      await db.insert(externalMovements).values({
        userId,
        externalAccountId: accountId,
        externalId: payload.id,
        payload,
        contentHash,
        sourceUpdatedAt,
      });
    }
  }

  async step(lease: IntegrationLease) {
    await assertIntegrationRole(this.db, 'app_user');
    const snapshot = await this.owned(lease.userId, (db) =>
      new IntegrationJobService(db).lock(lease),
    );
    const checkpoint = checkpointSchema.parse(snapshot.job.checkpoint);
    const payload = integrationPayloadSchema.parse(snapshot.job.payload);
    try {
      // Fetch outside the transaction. Only the owned atomic commit advances the checkpoint.
      const apply = await this.fetchPage(snapshot.connection, checkpoint, payload);
      return await this.owned(lease.userId, (ownedDb) =>
        runWithMaterializationLock(ownedDb, lease.userId, async ({ db }) => {
          const jobs = new IntegrationJobService(db);
          await jobs.lock(lease);
          const { next, done } = await apply(db, lease.userId);
          await jobs.checkpoint(lease, next, done);
          if (done && !payload.accountId && !payload.publishAccountId)
            await db
              .update(externalConnections)
              .set({
                lastFetchedAt: next.sweepStartedAt ? new Date(next.sweepStartedAt) : new Date(),
                sourceUpdatedAt: next.sourceUpdatedAt ? new Date(next.sourceUpdatedAt) : null,
                errorCode: null,
              })
              .where(
                and(
                  eq(externalConnections.userId, lease.userId),
                  eq(externalConnections.id, snapshot.connection.id),
                ),
              );
          return { status: done ? ('completed' as const) : ('progress' as const) };
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'INTEGRATION_LEASE_LOST')
        return { status: 'stale' as const };
      const code = error instanceof PluggyError ? error.message : 'INTEGRATION_PROCESSING_FAILED';
      const delay = error instanceof PluggyError ? Math.max(30, error.retryAfterMs / 1000) : 60;
      await this.owned(lease.userId, async (db) => {
        const jobs = new IntegrationJobService(db);
        await jobs.lock(lease);
        await jobs.checkpoint(
          lease,
          code === 'PLUGGY_STALE_SOURCE_READ'
            ? { ...checkpoint, cursor: null, seen: [], foundIds: [], absenceVersions: {} }
            : checkpoint,
          false,
          code,
          delay,
        );
        await db
          .update(externalConnections)
          .set({
            errorCode: code,
            ...(['PLUGGY_AUTH_REQUIRED', 'PLUGGY_NOT_FOUND'].includes(code)
              ? { status: 'auth_required' as const }
              : {}),
          })
          .where(
            and(
              eq(externalConnections.userId, lease.userId),
              eq(externalConnections.id, snapshot.connection.id),
            ),
          );
      });
      return { status: 'retry' as const };
    }
  }

  private async fetchPage(
    connection: typeof externalConnections.$inferSelect,
    checkpoint: Checkpoint,
    payload: z.infer<typeof integrationPayloadSchema>,
  ): Promise<(db: DbExecutor, userId: string) => Promise<{ next: Checkpoint; done: boolean }>> {
    if (payload.publishAccountId) {
      const rows = await this.owned(connection.userId, async (db) => {
        const [account] = await db
          .select()
          .from(externalAccounts)
          .where(
            and(
              eq(externalAccounts.id, payload.publishAccountId ?? ''),
              eq(externalAccounts.userId, connection.userId),
              eq(externalAccounts.connectionId, connection.id),
              eq(externalAccounts.kind, 'CREDIT'),
            ),
          );
        if (!account) throw new PluggyError('SCOPE_MISMATCH');
        return db
          .select({ id: externalMovements.id })
          .from(externalMovements)
          .where(
            and(
              eq(externalMovements.userId, connection.userId),
              eq(externalMovements.externalAccountId, account.id),
              checkpoint.publishAfter
                ? gt(externalMovements.id, checkpoint.publishAfter)
                : undefined,
            ),
          )
          .orderBy(externalMovements.id)
          .limit(101);
      });
      return async (db, userId) => {
        const batch = rows.slice(0, 100);
        for (const row of batch)
          await new PluggyCardReconciliationService(db).publish(userId, row.id);
        return {
          next: { ...checkpoint, publishAfter: batch.at(-1)?.id ?? checkpoint.publishAfter },
          done: rows.length <= 100,
        };
      };
    }
    if (checkpoint.phase === 'item') {
      const item = await this.client.getItem(connection.itemId);
      if (item.connector.id !== 200) throw new PluggyError('PERSONAL_CONNECTOR_REQUIRED');
      if (
        ['LOGIN_ERROR', 'WAITING_USER_INPUT'].includes(item.status) ||
        [
          'INVALID_CREDENTIALS',
          'INVALID_CREDENTIALS_MFA',
          'USER_INPUT_TIMEOUT',
          'ACCOUNT_LOCKED',
          'ACCOUNT_NEEDS_ACTION',
          'ACCOUNT_CREDENTIALS_RESET',
          'USER_AUTHORIZATION_NOT_GRANTED',
          'USER_AUTHORIZATION_REVOKED',
          'USER_AUTHORIZATION_PENDING',
        ].includes(item.executionStatus ?? '')
      )
        throw new PluggyError('AUTH_REQUIRED');
      if (item.status !== 'UPDATED') throw new PluggyError('SOURCE_NOT_READY');
      if (item.executionStatus === 'PARTIAL_SUCCESS') throw new PluggyError('SOURCE_PARTIAL');
      if (item.executionStatus && item.executionStatus !== 'SUCCESS')
        throw new PluggyError('SOURCE_NOT_READY');
      const start = connection.lastFetchedAt
        ? new Date(connection.lastFetchedAt.getTime() - 7 * 86_400_000)
        : new Date(Date.now() - 365 * 86_400_000);
      return async () => ({
        next: {
          ...checkpoint,
          phase: 'accounts',
          filters: payload.transactionIds.length
            ? { ids: payload.transactionIds }
            : payload.transactionsCreatedAtFrom
              ? { createdAtFrom: payload.transactionsCreatedAtFrom }
              : { dateFrom: payload.transactionsMinDate ?? start.toISOString().slice(0, 10) },
          windowFilters: { dateFrom: start.toISOString().slice(0, 10) },
          createdFilters: {
            createdAtFrom: connection.lastFetchedAt
              ? start.toISOString()
              : new Date(0).toISOString(),
          },
          sweepStartedAt: new Date().toISOString(),
          sourceUpdatedAt: item.lastUpdatedAt ?? null,
        },
        done: false,
      });
    }
    if (checkpoint.phase === 'accounts') {
      const allRows = await this.client.getAccounts(connection.itemId);
      const rows = payload.accountId
        ? allRows.filter((row) => row.id === payload.accountId)
        : allRows;
      if (payload.accountId && rows.length !== 1) throw new PluggyError('SCOPE_MISMATCH');
      if (rows.length > 500) throw new PluggyError('ACCOUNT_LIMIT');
      return async (db, userId) => {
        const accounts: (typeof externalAccounts.$inferSelect)[] = [];
        const existingAccounts = await db
          .select({ id: externalAccounts.externalId })
          .from(externalAccounts)
          .where(
            and(
              eq(externalAccounts.userId, userId),
              eq(externalAccounts.connectionId, connection.id),
            ),
          );
        const initialAccountIds: string[] = [];
        for (const row of rows) {
          const values = {
            name: row.name,
            kind: row.type,
            currency: row.currencyCode,
            balance: Money.fromNumber(row.balance, row.currencyCode).toDbString(),
            balanceType: 'unknown' as const,
            fetchedAt: new Date(),
            sourceUpdatedAt: checkpoint.sourceUpdatedAt
              ? new Date(checkpoint.sourceUpdatedAt)
              : null,
          };
          const [account] = await db
            .insert(externalAccounts)
            .values({ userId, connectionId: connection.id, externalId: row.id, ...values })
            .onConflictDoUpdate({
              target: externalAccounts.externalId,
              set: values,
              setWhere: and(
                eq(externalAccounts.userId, userId),
                eq(externalAccounts.connectionId, connection.id),
              ),
            })
            .returning();
          if (!account) throw new PluggyError('SCOPE_MISMATCH');
          accounts.push(account);
          if (!existingAccounts.some((old) => old.id === row.id))
            initialAccountIds.push(account.id);
        }
        return {
          next: {
            ...checkpoint,
            phase: accounts[0]?.kind === 'CREDIT' && !payload.accountId ? 'bills' : 'transactions',
            accountIds: accounts.map((row) => row.id),
            initialAccountIds,
          },
          done: accounts.length === 0,
        };
      };
    }
    const accountId = checkpoint.accountIds[checkpoint.index];
    const [account] = await this.owned(connection.userId, (db) =>
      db
        .select()
        .from(externalAccounts)
        .where(
          and(
            eq(externalAccounts.id, accountId),
            eq(externalAccounts.userId, connection.userId),
            eq(externalAccounts.connectionId, connection.id),
          ),
        ),
    );
    if (!account) throw new PluggyError('SCOPE_MISMATCH');
    if (checkpoint.phase === 'bills') {
      const bills = await this.client.getBills(account.externalId);
      return async (db, userId) => {
        for (const bill of bills) {
          await db
            .insert(externalBills)
            .values({ userId, externalAccountId: account.id, externalId: bill.id, payload: bill })
            .onConflictDoUpdate({
              target: [externalBills.externalAccountId, externalBills.externalId],
              set: { payload: bill, fetchedAt: new Date() },
              setWhere: eq(externalBills.userId, userId),
            });
        }
        return { next: { ...checkpoint, phase: 'transactions' }, done: false };
      };
    }
    const beforeIds =
      checkpoint.filters.ids && !checkpoint.cursor
        ? await this.owned(connection.userId, (db) =>
            db
              .select({
                externalId: externalMovements.externalId,
                version: externalMovements.version,
              })
              .from(externalMovements)
              .where(
                and(
                  eq(externalMovements.userId, connection.userId),
                  eq(externalMovements.externalAccountId, account.id),
                  inArray(externalMovements.externalId, checkpoint.filters.ids ?? []),
                ),
              ),
          )
        : [];
    const absenceVersions = checkpoint.cursor
      ? checkpoint.absenceVersions
      : Object.fromEntries(beforeIds.map((r) => [r.externalId, r.version]));
    const page = await this.client.getTransactionsPage(
      account.externalId,
      checkpoint.filters,
      checkpoint.cursor,
    );
    const foundIds = checkpoint.filters.ids
      ? [...new Set([...checkpoint.foundIds, ...page.results.map((row) => row.id)])]
      : [];
    if (
      checkpoint.filters.ids &&
      page.results.some((row) => !checkpoint.filters.ids?.includes(row.id))
    )
      throw new PluggyError('SCOPE_MISMATCH');
    let next = { ...checkpoint, foundIds };
    let done = false;
    if (page.next) {
      const hash = cursorHash(account.externalId, checkpoint, page.next);
      if (checkpoint.seen.includes(hash)) throw new PluggyError('CURSOR_REPEATED');
      if (checkpoint.seen.length >= 1000) throw new PluggyError('PAGE_LIMIT');
      next = {
        ...checkpoint,
        foundIds,
        absenceVersions,
        cursor: page.next,
        seen: [...checkpoint.seen, hash],
      };
    } else {
      const nextId = checkpoint.accountIds[checkpoint.index + 1];
      done = !nextId;
      let phase: Checkpoint['phase'] = 'transactions';
      if (nextId) {
        const [nextAccount] = await this.owned(connection.userId, (db) =>
          db
            .select()
            .from(externalAccounts)
            .where(
              and(
                eq(externalAccounts.id, nextId),
                eq(externalAccounts.userId, connection.userId),
                eq(externalAccounts.connectionId, connection.id),
              ),
            ),
        );
        if (!nextAccount) throw new PluggyError('SCOPE_MISMATCH');
        phase = nextAccount.kind === 'CREDIT' ? 'bills' : 'transactions';
      }
      next = {
        ...checkpoint,
        index: checkpoint.index + 1,
        cursor: null,
        seen: [],
        foundIds: [],
        phase,
        filters: checkpoint.windowFilters,
        refreshingPending: false,
        createdSweepDone: false,
        absenceVersions: {},
      };
      if (!payload.accountId && !checkpoint.createdSweepDone && !checkpoint.refreshingPending) {
        next = {
          ...checkpoint,
          filters: checkpoint.initialAccountIds.includes(account.id)
            ? { createdAtFrom: new Date(0).toISOString() }
            : checkpoint.createdFilters,
          cursor: null,
          seen: [],
          foundIds: [],
          absenceVersions: {},
          createdSweepDone: true,
        };
        done = false;
      } else if (!payload.accountId && !checkpoint.refreshingPending) {
        const pending = await this.owned(connection.userId, (db) =>
          db
            .select({ externalId: externalMovements.externalId })
            .from(externalMovements)
            .where(
              and(
                eq(externalMovements.userId, connection.userId),
                eq(externalMovements.externalAccountId, account.id),
                isNull(externalMovements.retractedAt),
                sql`${externalMovements.payload}->>'status' = 'PENDING'`,
              ),
            )
            .orderBy(externalMovements.id)
            .limit(501),
        );
        if (pending.length > 500) throw new PluggyError('PENDING_LIMIT');
        if (pending.length) {
          next = {
            ...checkpoint,
            filters: { ids: pending.map((row) => row.externalId) },
            cursor: null,
            seen: [],
            foundIds: [],
            refreshingPending: true,
            absenceVersions: {},
          };
          done = false;
        }
      }
    }
    return async (db, userId) => {
      const [fenced] = await db
        .update(externalAccounts)
        .set({ movementRevision: sql`${externalAccounts.movementRevision} + 1` })
        .where(
          and(
            eq(externalAccounts.userId, userId),
            eq(externalAccounts.id, account.id),
            eq(externalAccounts.movementRevision, account.movementRevision),
          ),
        )
        .returning({ id: externalAccounts.id });
      if (!fenced) throw new PluggyError('STALE_SOURCE_READ');
      for (const row of page.results) {
        await this.storeMovement(db, userId, account.id, row);
        if (account.kind === 'CREDIT') {
          const [stored] = await db
            .select({ id: externalMovements.id })
            .from(externalMovements)
            .where(
              and(
                eq(externalMovements.userId, userId),
                eq(externalMovements.externalAccountId, account.id),
                eq(externalMovements.externalId, row.id),
              ),
            );
          if (stored) await new PluggyCardReconciliationService(db).publish(userId, stored.id);
        }
      }
      if (
        (payload.event === 'transactions/deleted' || checkpoint.refreshingPending) &&
        page.next === null
      ) {
        const absent = (checkpoint.filters.ids ?? []).filter((id) => !foundIds.includes(id));
        if (absent.length) {
          const current = await db
            .select({
              externalId: externalMovements.externalId,
              version: externalMovements.version,
            })
            .from(externalMovements)
            .where(
              and(
                eq(externalMovements.userId, userId),
                eq(externalMovements.externalAccountId, account.id),
                inArray(externalMovements.externalId, absent),
              ),
            );
          if (current.some((row) => absenceVersions[row.externalId] !== row.version))
            throw new PluggyError('STALE_SOURCE_READ');
          const retracted = await db
            .update(externalMovements)
            .set({ retractedAt: new Date(), version: sql`${externalMovements.version} + 1` })
            .where(
              and(
                eq(externalMovements.userId, userId),
                eq(externalMovements.externalAccountId, account.id),
                inArray(externalMovements.externalId, absent),
                isNull(externalMovements.retractedAt),
              ),
            )
            .returning({ id: externalMovements.id });
          if (account.kind === 'CREDIT')
            for (const row of retracted)
              await new PluggyCardReconciliationService(db).publish(userId, row.id);
        }
      }
      return { next, done };
    };
  }
}
