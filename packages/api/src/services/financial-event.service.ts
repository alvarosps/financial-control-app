import { createHash } from 'node:crypto';
import type { DbExecutor } from '@fc/db';
import {
  accounts,
  financialEventRevisions,
  financialEvents,
  purchaseLedgerLinks,
  purchaseObservations,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import { resolveEventRevision, transitionObservation } from '@fc/domain';
import type { FinancialEventData, FinancialEventSource, PurchaseApplication } from '@fc/shared';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { loadPurchaseConfirmation } from '../lib/purchase-confirmation.ts';
import {
  financialEventDataSchema,
  ingestFinancialEventSchema,
  type PurchaseTarget,
} from '../lib/purchase-input.ts';
import { AuditService } from './audit.service.ts';

function financialFields(data: FinancialEventData) {
  const { confirmation: _confirmation, postedDate: _postedDate, ...fields } = data;
  return fields;
}

export function financialEventContentHash(data: FinancialEventData, parserVersion: string) {
  return createHash('sha256').update(JSON.stringify({ data, parserVersion })).digest('hex');
}

export class FinancialEventService {
  constructor(
    private db: DbExecutor,
    private enabledSources: readonly FinancialEventSource[] = ['manual', 'pdf'],
  ) {}

  async recordApplied(
    userId: string,
    input: unknown,
    target: PurchaseTarget,
    application: 'linked' | 'created',
    reviewed?: Pick<
      FinancialEventData,
      'description' | 'amount' | 'amountMeaning' | 'installmentNumber' | 'totalInstallments'
    > & { categoryId?: string },
  ) {
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new FinancialEventService(db, this.enabledSources);
      const captured = await service.ingest(userId, input);
      const resolved = await service.resolveTarget(userId, target);
      const [link] = await db
        .select()
        .from(purchaseLedgerLinks)
        .where(
          and(
            eq(purchaseLedgerLinks.userId, userId),
            eq(purchaseLedgerLinks.observationId, captured.observation.id),
            isNull(purchaseLedgerLinks.revokedAt),
          ),
        );
      if (link) {
        if (
          link.transactionId !== resolved.transactionId ||
          link.scheduleId !== resolved.scheduleId ||
          link.billingMonth !== resolved.billingMonth ||
          link.billingYear !== resolved.billingYear
        )
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Event already identifies another purchase',
          });
        return captured.observation.id;
      }
      if (captured.replayed) return captured.observation.id;
      if (reviewed) {
        const { categoryId, ...fields } = reviewed;
        const normalized = financialEventDataSchema.parse({
          ...ingestFinancialEventSchema.parse(input).data,
          ...fields,
          description: fields.description.trim().slice(0, 200),
        });
        const changes = {
          description: normalized.description,
          amount: normalized.amount,
          amountMeaning: normalized.amountMeaning,
          installmentNumber: normalized.installmentNumber,
          totalInstallments: normalized.totalInstallments,
          ...(categoryId === undefined ? {} : { categoryId }),
        };
        if (
          Object.entries(changes).some(
            ([key, value]) => captured.observation[key as keyof typeof changes] !== value,
          )
        ) {
          const [corrected] = await db
            .update(purchaseObservations)
            .set({
              ...changes,
              manuallyCorrected: true,
              version: captured.observation.version + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(purchaseObservations.userId, userId),
                eq(purchaseObservations.id, captured.observation.id),
              ),
            )
            .returning();
          await new AuditService(db).log(
            userId,
            'review',
            'purchase_observation',
            captured.observation.id,
            captured.observation,
            corrected,
          );
        }
      }
      return service.attach(userId, captured.observation.id, target, application);
    });
  }

  recordManual(userId: string, data: FinancialEventData, target: PurchaseTarget) {
    const id =
      'transactionId' in target
        ? target.transactionId
        : `${target.scheduleId}:${target.billingYear ?? ''}:${target.billingMonth ?? ''}`;
    return this.recordApplied(
      userId,
      {
        source: 'manual',
        sourceScope: 'card-flow',
        externalId: id,
        sourceVersion: 1,
        parserVersion: 'card-flow-1',
        observedAt: new Date(),
        data: { ...data, description: data.description.trim().slice(0, 200) },
      },
      target,
      'created',
    );
  }

  async ingest(userId: string, rawInput: unknown) {
    const parsed = ingestFinancialEventSchema.safeParse(rawInput);
    if (!parsed.success)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid normalized financial event' });
    const input = parsed.data;
    if (!this.enabledSources.includes(input.source))
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Source is disabled' });
    const contentHash = financialEventContentHash(input.data, input.parserVersion);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      if (input.data.cardAccountId) {
        const [card] = await db
          .select()
          .from(accounts)
          .where(
            and(
              eq(accounts.id, input.data.cardAccountId),
              eq(accounts.userId, userId),
              eq(accounts.type, 'credit_card'),
            ),
          );
        if (!card) throw new TRPCError({ code: 'NOT_FOUND', message: 'Card not found' });
      }
      let [event] = await db
        .select()
        .from(financialEvents)
        .where(
          and(
            eq(financialEvents.userId, userId),
            eq(financialEvents.source, input.source),
            eq(financialEvents.sourceScope, input.sourceScope),
            eq(financialEvents.externalId, input.externalId),
          ),
        )
        .for('update');
      let observation: typeof purchaseObservations.$inferSelect;
      let replayed = false;
      let stale = false;
      if (event) {
        const [revision] = await db
          .select()
          .from(financialEventRevisions)
          .where(
            and(
              eq(financialEventRevisions.userId, userId),
              eq(financialEventRevisions.eventId, event.id),
              eq(financialEventRevisions.sourceVersion, input.sourceVersion),
            ),
          );
        if (revision && revision.contentHash !== contentHash)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Source revision has conflicting content',
          });
        let disposition: ReturnType<typeof resolveEventRevision>;
        try {
          disposition = resolveEventRevision(
            event.currentVersion,
            event.currentHash,
            input.sourceVersion,
            contentHash,
          );
        } catch {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Source revision has conflicting content',
          });
        }
        replayed = Boolean(revision);
        stale = disposition === 'stale';
        const [current] = await db
          .select()
          .from(purchaseObservations)
          .where(
            and(
              eq(purchaseObservations.id, event.observationId),
              eq(purchaseObservations.userId, userId),
            ),
          )
          .for('update');
        if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase not found' });
        observation = current;
        if (disposition === 'advance') {
          const [previous] = await db
            .select()
            .from(financialEventRevisions)
            .where(
              and(
                eq(financialEventRevisions.userId, userId),
                eq(financialEventRevisions.eventId, event.id),
                eq(financialEventRevisions.sourceVersion, event.currentVersion),
              ),
            );
          const [link] = await db
            .select()
            .from(purchaseLedgerLinks)
            .where(
              and(
                eq(purchaseLedgerLinks.userId, userId),
                eq(purchaseLedgerLinks.observationId, current.id),
                isNull(purchaseLedgerLinks.revokedAt),
              ),
            );
          const confirmation = await loadPurchaseConfirmation(db, userId, current.id, {
            eventId: event.id,
            confirmation: input.data.confirmation,
          });
          const next = transitionObservation(
            { ...current, application: link?.application ?? 'unapplied' },
            confirmation,
            !previous ||
              JSON.stringify(financialFields(previous.data)) !==
                JSON.stringify(financialFields(input.data)),
          );
          [observation] = await db
            .update(purchaseObservations)
            .set({
              ...(next.updateFields ? financialFields(input.data) : {}),
              postedDate: current.manuallyCorrected
                ? current.postedDate
                : (input.data.postedDate ?? current.postedDate),
              confirmation,
              review: next.review,
              version: current.version + 1,
              updatedAt: new Date(),
            })
            .where(
              and(eq(purchaseObservations.id, current.id), eq(purchaseObservations.userId, userId)),
            )
            .returning();
          [event] = await db
            .update(financialEvents)
            .set({
              currentVersion: input.sourceVersion,
              currentHash: contentHash,
              lastReceivedAt: new Date(),
            })
            .where(and(eq(financialEvents.id, event.id), eq(financialEvents.userId, userId)))
            .returning();
        }
      } else {
        [observation] = await db
          .insert(purchaseObservations)
          .values({
            userId,
            ...input.data,
            review: input.data.confirmation === 'retracted' ? 'needs_review' : 'unreviewed',
          })
          .returning();
        [event] = await db
          .insert(financialEvents)
          .values({
            userId,
            observationId: observation.id,
            source: input.source,
            sourceScope: input.sourceScope,
            externalId: input.externalId,
            currentVersion: input.sourceVersion,
            currentHash: contentHash,
          })
          .returning();
      }
      if (!replayed) {
        await db.insert(financialEventRevisions).values({
          userId,
          eventId: event.id,
          sourceVersion: input.sourceVersion,
          contentHash,
          parserVersion: input.parserVersion,
          observedAt: input.observedAt,
          data: input.data,
        });
        await new AuditService(db).log(
          userId,
          'capture',
          'purchase_observation',
          observation.id,
          undefined,
          { eventId: event.id, source: input.source, sourceVersion: input.sourceVersion, stale },
        );
      }
      return { event, observation, replayed, stale };
    });
  }

  async resolveTarget(
    userId: string,
    target: PurchaseTarget,
  ): Promise<{
    transactionId: string | null;
    scheduleId: string | null;
    billingMonth: number | null;
    billingYear: number | null;
    cardAccountId: string;
    currency: string;
    kind: 'purchase' | 'refund';
  }> {
    if ('transactionId' in target) {
      const [row] = await this.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.id, target.transactionId),
            eq(transactions.userId, userId),
            eq(transactions.isReversed, false),
            isNull(transactions.reversesTransactionId),
          ),
        )
        .for('update');
      if (
        !row ||
        ![
          'credit_card_expense',
          'credit_card_installment',
          'credit_card_fixed_charge',
          'credit_card_refund',
        ].includes(row.domainType ?? '')
      )
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Card transaction not found' });
      if (row.scheduledTransactionId)
        return this.resolveTarget(userId, {
          scheduleId: row.scheduledTransactionId,
          ...(row.domainType !== 'credit_card_installment' && row.billingMonth && row.billingYear
            ? { billingMonth: row.billingMonth, billingYear: row.billingYear }
            : {}),
        });
      return {
        transactionId: row.id,
        scheduleId: null,
        billingMonth: null,
        billingYear: null,
        cardAccountId: row.destinationAccountId,
        currency: row.currency,
        kind: row.domainType === 'credit_card_refund' ? ('refund' as const) : ('purchase' as const),
      };
    }
    const [row] = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.id, target.scheduleId),
          eq(scheduledTransactions.userId, userId),
        ),
      )
      .for('update');
    if (
      !row ||
      ![
        'credit_card_installment',
        'credit_card_fixed_charge',
        'credit_card_expense',
        'credit_card_refund',
      ].includes(row.domainType ?? '')
    )
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Card schedule not found' });
    const installment = row.domainType === 'credit_card_installment';
    if (!installment && (!target.billingMonth || !target.billingYear))
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Recurring purchase requires a billing period',
      });
    return {
      transactionId: null,
      scheduleId: row.id,
      billingMonth: installment ? null : (target.billingMonth ?? null),
      billingYear: installment ? null : (target.billingYear ?? null),
      cardAccountId: row.destinationAccountId,
      currency: row.currency,
      kind: row.domainType === 'credit_card_refund' ? 'refund' : 'purchase',
    };
  }

  /** Attach provenance only. Never create or modify financial transactions here. */
  async attach(
    userId: string,
    observationId: string,
    target: PurchaseTarget,
    application: Exclude<PurchaseApplication, 'unapplied'> = 'linked',
  ) {
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new FinancialEventService(db, this.enabledSources);
      const resolved = await service.resolveTarget(userId, target);
      const [observation] = await db
        .select()
        .from(purchaseObservations)
        .where(
          and(
            eq(purchaseObservations.id, observationId),
            eq(purchaseObservations.userId, userId),
            isNull(purchaseObservations.mergedIntoId),
          ),
        )
        .for('update');
      if (!observation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase not found' });
      if (
        (observation.cardAccountId && observation.cardAccountId !== resolved.cardAccountId) ||
        observation.currency !== resolved.currency ||
        observation.kind !== resolved.kind
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Purchase and ledger identity differ',
        });
      const [ownLink] = await db
        .select()
        .from(purchaseLedgerLinks)
        .where(
          and(
            eq(purchaseLedgerLinks.userId, userId),
            eq(purchaseLedgerLinks.observationId, observation.id),
            isNull(purchaseLedgerLinks.revokedAt),
          ),
        );
      if (ownLink) {
        if (
          ownLink.transactionId !== resolved.transactionId ||
          ownLink.scheduleId !== resolved.scheduleId ||
          ownLink.billingMonth !== resolved.billingMonth ||
          ownLink.billingYear !== resolved.billingYear
        )
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Unlink purchase before changing its target',
          });
        await db
          .update(purchaseObservations)
          .set({ review: 'accepted', version: observation.version + 1, updatedAt: new Date() })
          .where(
            and(
              eq(purchaseObservations.id, observation.id),
              eq(purchaseObservations.userId, userId),
            ),
          );
        await new AuditService(db).log(
          userId,
          'acknowledge',
          'purchase_observation',
          observation.id,
          { review: observation.review },
          { review: 'accepted', linkId: ownLink.id },
        );
        return observation.id;
      }
      const [existing] = await db
        .select()
        .from(purchaseLedgerLinks)
        .where(
          and(
            eq(purchaseLedgerLinks.userId, userId),
            isNull(purchaseLedgerLinks.revokedAt),
            resolved.transactionId
              ? eq(purchaseLedgerLinks.transactionId, resolved.transactionId)
              : and(
                  eq(purchaseLedgerLinks.scheduleId, resolved.scheduleId ?? ''),
                  resolved.billingMonth
                    ? and(
                        eq(purchaseLedgerLinks.billingMonth, resolved.billingMonth),
                        eq(purchaseLedgerLinks.billingYear, resolved.billingYear ?? 0),
                      )
                    : isNull(purchaseLedgerLinks.billingMonth),
                ),
          ),
        );
      let canonicalId = observation.id;
      if (existing) {
        canonicalId = existing.observationId;
        const [canonical] = await db
          .select()
          .from(purchaseObservations)
          .where(
            and(eq(purchaseObservations.id, canonicalId), eq(purchaseObservations.userId, userId)),
          )
          .for('update');
        if (!canonical || canonical.mergedIntoId)
          throw new TRPCError({ code: 'CONFLICT', message: 'Canonical purchase changed' });
        await db
          .update(financialEvents)
          .set({ observationId: canonicalId })
          .where(
            and(
              eq(financialEvents.userId, userId),
              eq(financialEvents.observationId, observation.id),
            ),
          );
        await db
          .update(purchaseObservations)
          .set({
            mergedIntoId: canonicalId,
            version: observation.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(purchaseObservations.id, observation.id),
              eq(purchaseObservations.userId, userId),
            ),
          );
        const confirmation = await loadPurchaseConfirmation(db, userId, canonicalId);
        await db
          .update(purchaseObservations)
          .set({
            confirmation,
            review:
              confirmation === 'retracted' && canonical.review !== 'ignored'
                ? 'needs_review'
                : canonical.review,
            postedDate: canonical.manuallyCorrected
              ? canonical.postedDate
              : (canonical.postedDate ?? observation.postedDate),
            purchaseDate: canonical.manuallyCorrected
              ? canonical.purchaseDate
              : (canonical.purchaseDate ?? observation.purchaseDate),
            version: canonical.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(eq(purchaseObservations.id, canonicalId), eq(purchaseObservations.userId, userId)),
          );
      } else {
        await db
          .update(purchaseObservations)
          .set({
            cardAccountId: resolved.cardAccountId,
            review: observation.confirmation === 'retracted' ? 'needs_review' : 'accepted',
            version: observation.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(purchaseObservations.id, observation.id),
              eq(purchaseObservations.userId, userId),
            ),
          );
        const {
          cardAccountId: _cardAccountId,
          currency: _currency,
          kind: _kind,
          ...columns
        } = resolved;
        await db
          .insert(purchaseLedgerLinks)
          .values({ userId, observationId, application, ...columns });
      }
      await new AuditService(db).log(
        userId,
        existing ? 'merge_evidence' : 'link',
        'purchase_observation',
        canonicalId,
        { observationId },
        { target, application: existing?.application ?? application },
      );
      return canonicalId;
    });
  }
}
