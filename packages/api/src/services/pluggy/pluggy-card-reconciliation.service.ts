import type { DbExecutor } from '@fc/db';
import {
  externalAccounts,
  externalBills,
  externalMovements,
  financialEventRevisions,
  financialEvents,
  purchaseObservations,
} from '@fc/db';
import { Money, resolveStatementCycle, type StatementCycle } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { loadEffectiveCardConfigs } from '../../lib/card-group.ts';
import { runWithMaterializationLock } from '../../lib/materialization-lock.ts';
import { financialEventDataSchema } from '../../lib/purchase-input.ts';
import { FinancialEventService, financialEventContentHash } from '../financial-event.service.ts';
import { StatementCycleService } from '../statement-cycle.service.ts';
import { normalizePluggyCard } from './pluggy-normalizer.ts';
import { pluggyBillSchema, pluggyTransactionSchema } from './pluggy-types.ts';

export const pluggySourceScope = (
  account: Pick<typeof externalAccounts.$inferSelect, 'id' | 'connectionId'>,
) => `${account.connectionId}:${account.id}`;
export class PluggyCardReconciliationService {
  constructor(private db: DbExecutor) {}
  async relatedPurchases(userId: string, observationId: string) {
    return this.db
      .selectDistinct({
        observationId: purchaseObservations.id,
        version: purchaseObservations.version,
        description: purchaseObservations.description,
        amount: purchaseObservations.amount,
        currency: purchaseObservations.currency,
        confirmation: purchaseObservations.confirmation,
        sameInstitutionalReference: sql<boolean>`true`,
      })
      .from(purchaseObservations)
      .innerJoin(
        financialEvents,
        and(
          eq(financialEvents.userId, userId),
          eq(financialEvents.observationId, purchaseObservations.id),
          eq(financialEvents.source, 'pluggy'),
        ),
      )
      .innerJoin(
        externalMovements,
        and(
          eq(externalMovements.userId, userId),
          sql`${externalMovements.externalId}::text = ${financialEvents.externalId}`,
        ),
      )
      .innerJoin(
        externalAccounts,
        and(
          eq(externalAccounts.userId, userId),
          eq(externalAccounts.id, externalMovements.externalAccountId),
          sql`${financialEvents.sourceScope} = ${externalAccounts.connectionId}::text || ':' || ${externalAccounts.id}::text`,
        ),
      )
      .where(
        and(
          eq(purchaseObservations.userId, userId),
          ne(purchaseObservations.id, observationId),
          isNull(purchaseObservations.mergedIntoId),
          ne(purchaseObservations.review, 'ignored'),
          ne(purchaseObservations.confirmation, 'retracted'),
          isNull(externalMovements.retractedAt),
          sql`nullif(trim(${externalMovements.payload}->>'providerId'), '') IS NOT NULL`,
          sql`EXISTS (
          SELECT 1 FROM financial_events own_event
          JOIN external_movements own_movement ON own_movement.user_id = ${userId}
            AND own_event.external_id = own_movement.external_id::text
            AND own_movement.external_account_id = ${externalAccounts.id}
          WHERE own_event.user_id = ${userId} AND own_event.source = 'pluggy'
            AND own_event.source_scope = ${financialEvents.sourceScope}
            AND own_event.observation_id = ${observationId}
            AND own_movement.retracted_at IS NULL
            AND own_movement.payload->>'providerId' = ${externalMovements.payload}->>'providerId'
        )`,
        ),
      )
      .limit(50);
  }
  async evidence(userId: string, observationId: string) {
    const [observation] = await this.db
      .select()
      .from(purchaseObservations)
      .where(
        and(eq(purchaseObservations.userId, userId), eq(purchaseObservations.id, observationId)),
      );
    if (!observation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase not found' });
    const rows = await this.db
      .select({ movement: externalMovements, account: externalAccounts })
      .from(financialEvents)
      .innerJoin(
        externalMovements,
        and(
          eq(externalMovements.userId, userId),
          sql`${financialEvents.externalId} = ${externalMovements.externalId}::text`,
        ),
      )
      .innerJoin(
        externalAccounts,
        and(
          eq(externalAccounts.userId, userId),
          eq(externalAccounts.id, externalMovements.externalAccountId),
          sql`${financialEvents.sourceScope} = ${externalAccounts.connectionId}::text || ':' || ${externalAccounts.id}::text`,
        ),
      )
      .where(
        and(
          eq(financialEvents.userId, userId),
          eq(financialEvents.source, 'pluggy'),
          eq(financialEvents.observationId, observationId),
        ),
      )
      .orderBy(desc(externalMovements.sourceUpdatedAt))
      .limit(200);
    const bills = rows.length
      ? await this.db
          .select()
          .from(externalBills)
          .where(
            and(
              eq(externalBills.userId, userId),
              inArray(
                externalBills.externalAccountId,
                rows.map((row) => row.account.id),
              ),
            ),
          )
      : [];
    const configs = observation.cardAccountId
      ? await loadEffectiveCardConfigs(this.db, userId, [observation.cardAccountId])
      : new Map();
    return rows.map(({ movement, account }) => {
      const raw = pluggyTransactionSchema.parse(movement.payload);
      const bill = bills.find(
        (bill) =>
          bill.externalAccountId === account.id &&
          bill.externalId === raw.creditCardMetadata?.billId,
      );
      const parsedBill = pluggyBillSchema.safeParse(bill?.payload);
      let cycle: StatementCycle | null = null;
      let cycleIssue = false;
      if (parsedBill.success) {
        const closingDate = parsedBill.data.billClosingDate?.slice(0, 10) ?? null;
        const dueDate = parsedBill.data.dueDate?.slice(0, 10) ?? null;
        const reference = closingDate ?? dueDate;
        if (reference) {
          const [year, month] = reference.split('-').map(Number);
          try {
            cycle = resolveStatementCycle({
              reference: closingDate ? 'closing' : 'due',
              month,
              year,
              closingDate,
              dueDate,
              config: observation.cardAccountId
                ? configs.get(observation.cardAccountId)
                : undefined,
            });
          } catch {
            cycleIssue = true;
          }
        }
      }
      return {
        movementId: movement.id,
        providerId: raw.providerId ?? null,
        cardLastFour: raw.creditCardMetadata?.cardNumber ?? null,
        installmentNumber: raw.creditCardMetadata?.installmentNumber ?? null,
        forecastPeriod: raw.creditCardMetadata?.billForecastDate ?? null,
        operationType: raw.operationType ?? null,
        retractedAt: movement.retractedAt,
        cycle,
        cycleIssue,
        billTotal: parsedBill.success
          ? Money.fromNumber(
              parsedBill.data.totalAmount,
              parsedBill.data.totalAmountCurrencyCode,
            ).toDbString()
          : null,
      };
    });
  }

  async applyReviewedCycle(
    userId: string,
    observationId: string,
    cardAccountId: string,
    month: number,
    year: number,
  ) {
    const [observation] = await this.db
      .select()
      .from(purchaseObservations)
      .where(
        and(eq(purchaseObservations.userId, userId), eq(purchaseObservations.id, observationId)),
      );
    if (!observation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase not found' });
    const evidence = (await this.evidence(userId, observationId)).filter(
      (row) =>
        row.retractedAt === null &&
        (observation.installmentNumber === null ||
          row.installmentNumber === observation.installmentNumber),
    );
    for (const row of evidence) {
      if (
        row.cycleIssue ||
        (row.cycle && (row.cycle.billingMonth !== month || row.cycle.billingYear !== year))
      )
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Review the institutional statement period before applying',
        });
      if (row.cycle)
        await new StatementCycleService(this.db).persist(
          userId,
          { cardAccountId, month, year },
          row.cycle,
        );
    }
  }

  async publish(userId: string, movementId: string) {
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const [movement] = await db
        .select()
        .from(externalMovements)
        .where(and(eq(externalMovements.id, movementId), eq(externalMovements.userId, userId)))
        .for('update');
      if (!movement) throw new TRPCError({ code: 'NOT_FOUND', message: 'Evidence not found' });
      const [account] = await db
        .select()
        .from(externalAccounts)
        .where(
          and(
            eq(externalAccounts.userId, userId),
            eq(externalAccounts.id, movement.externalAccountId),
          ),
        );
      if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
      if (account.kind !== 'CREDIT') return null;
      const raw = pluggyTransactionSchema.parse(movement.payload);
      if (raw.id !== movement.externalId || raw.accountId !== account.externalId)
        throw new Error('INTEGRATION_SCOPE_MISMATCH');
      const normalized = normalizePluggyCard(raw, account.accountId, movement.retractedAt !== null);
      const sourceScope = pluggySourceScope(account);
      const [event] = await db
        .select()
        .from(financialEvents)
        .where(
          and(
            eq(financialEvents.userId, userId),
            eq(financialEvents.source, 'pluggy'),
            eq(financialEvents.sourceScope, sourceScope),
            eq(financialEvents.externalId, movement.externalId),
          ),
        );
      let data = normalized.kind === 'purchase' ? normalized.data : null;
      if (!data && event) {
        const [revision] = await db
          .select()
          .from(financialEventRevisions)
          .where(
            and(
              eq(financialEventRevisions.userId, userId),
              eq(financialEventRevisions.eventId, event.id),
              eq(financialEventRevisions.sourceVersion, event.currentVersion),
            ),
          );
        if (revision) data = { ...revision.data, confirmation: 'retracted' };
      }
      if (!data) return null;
      const parsed = financialEventDataSchema.parse(data);
      const parserVersion = 'pluggy-1';
      const hash = financialEventContentHash(parsed, parserVersion);
      const sourceVersion = event ? event.currentVersion + (event.currentHash === hash ? 0 : 1) : 1;
      return new FinancialEventService(db, ['pluggy']).ingest(userId, {
        source: 'pluggy',
        sourceScope,
        externalId: movement.externalId,
        sourceVersion,
        parserVersion,
        observedAt: movement.fetchedAt,
        data: parsed,
      });
    });
  }
}
