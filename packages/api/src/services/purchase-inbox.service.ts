import type { DbExecutor } from '@fc/db';
import {
  accounts,
  categories,
  financialEventRevisions,
  financialEvents,
  purchaseLedgerLinks,
  purchaseObservations,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import { Money, matchFaturaItems, purchaseApplicationAmounts } from '@fc/domain';
import type { PurchaseApplication } from '@fc/shared';
import { TRPCError } from '@trpc/server';
import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { loadPurchaseConfirmation } from '../lib/purchase-confirmation.ts';
import {
  purchaseAcceptSchema,
  purchaseLinkSchema,
  purchaseListSchema,
  purchaseReviewSchema,
  purchaseSeparateEvidenceSchema,
  purchaseVersionSchema,
} from '../lib/purchase-input.ts';
import { assertOpenSettlementPeriods } from '../lib/settlement-guards.ts';
import { AuditService } from './audit.service.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { FaturaMatchRuleService } from './fatura-match-rule.service.ts';
import { FinancialEventService } from './financial-event.service.ts';
import { PluggyCardReconciliationService } from './pluggy/pluggy-card-reconciliation.service.ts';

type Observation = typeof purchaseObservations.$inferSelect;
type Version = z.infer<typeof purchaseVersionSchema>;

function amounts(purchase: Observation) {
  try {
    return purchaseApplicationAmounts(purchase);
  } catch {
    return null;
  }
}

export class PurchaseInboxService {
  constructor(private db: DbExecutor) {}

  private async owned(userId: string, id: string, version?: number) {
    const query = this.db
      .select()
      .from(purchaseObservations)
      .where(
        and(
          eq(purchaseObservations.userId, userId),
          eq(purchaseObservations.id, id),
          isNull(purchaseObservations.mergedIntoId),
        ),
      );
    const [row] = await (version === undefined ? query : query.for('update'));
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase not found' });
    if (version !== undefined && row.version !== version)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Purchase changed. Reload before reviewing.',
      });
    return row;
  }

  private async decorate(userId: string, rows: Observation[]) {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const links = await this.db
      .select({
        link: purchaseLedgerLinks,
        transaction: transactions,
        schedule: scheduledTransactions,
      })
      .from(purchaseLedgerLinks)
      .leftJoin(
        transactions,
        and(
          eq(transactions.id, purchaseLedgerLinks.transactionId),
          eq(transactions.userId, userId),
        ),
      )
      .leftJoin(
        scheduledTransactions,
        and(
          eq(scheduledTransactions.id, purchaseLedgerLinks.scheduleId),
          eq(scheduledTransactions.userId, userId),
        ),
      )
      .where(
        and(
          eq(purchaseLedgerLinks.userId, userId),
          inArray(purchaseLedgerLinks.observationId, ids),
          isNull(purchaseLedgerLinks.revokedAt),
        ),
      );
    const appliedTotals = await this.db
      .select({
        observationId: purchaseLedgerLinks.observationId,
        amount: sql<string>`coalesce(sum(${transactions.amount}), 0)::text`,
      })
      .from(purchaseLedgerLinks)
      .leftJoin(
        transactions,
        and(
          eq(transactions.userId, userId),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          or(
            eq(transactions.id, purchaseLedgerLinks.transactionId),
            and(
              eq(transactions.scheduledTransactionId, purchaseLedgerLinks.scheduleId),
              or(
                isNull(purchaseLedgerLinks.billingMonth),
                and(
                  eq(transactions.billingMonth, purchaseLedgerLinks.billingMonth),
                  eq(transactions.billingYear, purchaseLedgerLinks.billingYear),
                ),
              ),
            ),
          ),
        ),
      )
      .where(
        and(
          eq(purchaseLedgerLinks.userId, userId),
          inArray(purchaseLedgerLinks.observationId, ids),
          isNull(purchaseLedgerLinks.revokedAt),
        ),
      )
      .groupBy(purchaseLedgerLinks.observationId);
    const events = await this.db
      .select()
      .from(financialEvents)
      .where(and(eq(financialEvents.userId, userId), inArray(financialEvents.observationId, ids)));
    const cardIds = rows.flatMap((row) => (row.cardAccountId ? [row.cardAccountId] : []));
    const cards = cardIds.length
      ? await this.db
          .select({ id: accounts.id, name: accounts.name })
          .from(accounts)
          .where(and(eq(accounts.userId, userId), inArray(accounts.id, cardIds)))
      : [];
    return rows.map((row) => {
      const linked = links.find((item) => item.link.observationId === row.id);
      const total = appliedTotals.find((item) => item.observationId === row.id);
      const appliedAmount = total
        ? Money.fromString(total.amount, row.currency).toDbString()
        : null;
      return {
        ...row,
        cardName: cards.find((card) => card.id === row.cardAccountId)?.name ?? null,
        application: (linked?.link.application ?? 'unapplied') as PurchaseApplication,
        link: linked?.link ?? null,
        estimatedTotal: amounts(row)?.totalAmount ?? null,
        appliedAmount,
        ledgerReversed: linked?.transaction?.isReversed ?? false,
        sources: [
          ...new Set(
            events.filter((event) => event.observationId === row.id).map((event) => event.source),
          ),
        ],
      };
    });
  }

  async list(userId: string, rawInput: z.input<typeof purchaseListSchema>) {
    const input = purchaseListSchema.parse(rawInput);
    const scope = and(
      eq(purchaseObservations.userId, userId),
      isNull(purchaseObservations.mergedIntoId),
      input.cardAccountId ? eq(purchaseObservations.cardAccountId, input.cardAccountId) : undefined,
    );
    const counts = await this.db
      .select({ review: purchaseObservations.review, count: count() })
      .from(purchaseObservations)
      .where(scope)
      .groupBy(purchaseObservations.review);
    const rows = await this.db
      .select()
      .from(purchaseObservations)
      .where(
        and(
          scope,
          input.review ? eq(purchaseObservations.review, input.review) : undefined,
          input.unknownDate ? isNull(purchaseObservations.purchaseDate) : undefined,
          input.fromDate ? gte(purchaseObservations.purchaseDate, input.fromDate) : undefined,
          input.toDate ? lte(purchaseObservations.purchaseDate, input.toDate) : undefined,
          input.cursor
            ? sql`(${purchaseObservations.createdAt}, ${purchaseObservations.id}) < (SELECT created_at, id FROM purchase_observations WHERE id = ${input.cursor}::uuid AND user_id = ${userId}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(purchaseObservations.createdAt), desc(purchaseObservations.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: await this.decorate(userId, page),
      nextCursor: rows.length > input.limit && last ? last.id : null,
      counts: {
        unreviewed: 0,
        needs_review: 0,
        accepted: 0,
        ignored: 0,
        ...Object.fromEntries(counts.map((row) => [row.review, row.count])),
      },
    };
  }

  private async candidates(userId: string, purchase: Observation) {
    if (!purchase.cardAccountId) return [];
    const comparableAmount = amounts(purchase)?.installmentAmount ?? purchase.amount;
    const rows = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.destinationAccountId, purchase.cardAccountId),
          eq(transactions.currency, purchase.currency),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          inArray(
            transactions.domainType,
            purchase.kind === 'refund'
              ? ['credit_card_refund']
              : ['credit_card_expense', 'credit_card_installment', 'credit_card_fixed_charge'],
          ),
          purchase.installmentNumber
            ? eq(transactions.installmentNumber, purchase.installmentNumber)
            : undefined,
          eq(transactions.amount, comparableAmount),
        ),
      )
      .orderBy(desc(transactions.date), desc(transactions.id))
      .limit(100);
    const expected = rows.map((row) => ({
      transactionId: row.id,
      cardAccountId: row.destinationAccountId,
      scheduleId: row.scheduledTransactionId,
      description: row.description,
      amountBRL: row.amount,
      date: row.date.toISOString().slice(0, 10),
      domainType: row.domainType,
      installmentNumber: row.installmentNumber,
      totalInstallments: row.totalInstallments,
    }));
    const rules = await new FaturaMatchRuleService(this.db).listForCards(userId, [
      purchase.cardAccountId,
    ]);
    const matched = matchFaturaItems({
      parsed: [
        {
          description: purchase.description,
          amountBRL: comparableAmount,
          purchaseDate: purchase.purchaseDate,
          postedDate: purchase.postedDate,
          installmentCurrent: purchase.installmentNumber,
          installmentTotal: purchase.totalInstallments,
          isRefund: purchase.kind === 'refund',
          cardLastFour: null,
          holderName: null,
          isAdditional: false,
        },
      ],
      expected,
      aliases: {},
      learnedScheduleIds: Object.fromEntries(
        rules.map((rule) => [rule.rawNormalized, rule.scheduleId]),
      ),
    });
    const suggestions = new Set(
      [...matched.matched, ...matched.review].map((pair) => pair.expected.transactionId),
    );
    return rows
      .map((row) => ({
        transactionId: row.id,
        scheduleId: row.scheduledTransactionId,
        description: row.description,
        amount: row.amount,
        installmentNumber: row.installmentNumber,
        totalInstallments: row.totalInstallments,
        billingMonth: row.billingMonth,
        billingYear: row.billingYear,
        date: row.date,
        suggested: suggestions.has(row.id),
      }))
      .sort((a, b) => Number(b.suggested) - Number(a.suggested));
  }

  async detail(userId: string, id: string) {
    const row = await this.owned(userId, id);
    const [purchase] = await this.decorate(userId, [row]);
    const events = await this.db
      .select()
      .from(financialEvents)
      .where(and(eq(financialEvents.userId, userId), eq(financialEvents.observationId, id)))
      .orderBy(financialEvents.createdAt, financialEvents.id);
    const revisions = events.length
      ? await this.db
          .select()
          .from(financialEventRevisions)
          .where(
            and(
              eq(financialEventRevisions.userId, userId),
              inArray(
                financialEventRevisions.eventId,
                events.map((event) => event.id),
              ),
            ),
          )
          .orderBy(financialEventRevisions.sourceVersion)
      : [];
    return {
      purchase,
      events: events.map((event) => ({
        ...event,
        revisions: revisions.filter((revision) => revision.eventId === event.id),
      })),
      candidates: await this.candidates(userId, row),
      institutionEvidence: await new PluggyCardReconciliationService(this.db).evidence(userId, id),
      relatedPurchases: await new PluggyCardReconciliationService(this.db).relatedPurchases(
        userId,
        id,
      ),
    };
  }

  private async activeLink(userId: string, id: string) {
    const [link] = await this.db
      .select()
      .from(purchaseLedgerLinks)
      .where(
        and(
          eq(purchaseLedgerLinks.userId, userId),
          eq(purchaseLedgerLinks.observationId, id),
          isNull(purchaseLedgerLinks.revokedAt),
        ),
      );
    return link;
  }

  async review(userId: string, rawInput: z.input<typeof purchaseReviewSchema>) {
    const input = purchaseReviewSchema.parse(rawInput);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new PurchaseInboxService(db);
      const row = await service.owned(userId, input.observationId, input.version);
      const financialChange = Object.keys(input.changes).some((key) => key !== 'unrecognized');
      if (financialChange && (await service.activeLink(userId, row.id)))
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Unlink before correcting financial fields',
        });
      const next = { ...row, ...input.changes };
      if (
        (next.installmentNumber === null) !== (next.totalInstallments === null) ||
        (next.installmentNumber ?? 1) > (next.totalInstallments ?? 1)
      )
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid installment identity' });
      if (next.cardAccountId) {
        const [card] = await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, next.cardAccountId),
              eq(accounts.userId, userId),
              eq(accounts.type, 'credit_card'),
            ),
          );
        if (!card) throw new TRPCError({ code: 'NOT_FOUND', message: 'Card not found' });
      }
      if (next.categoryId) {
        const [category] = await db
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.id, next.categoryId), eq(categories.userId, userId)));
        if (!category) throw new TRPCError({ code: 'NOT_FOUND', message: 'Category not found' });
      }
      const [updated] = await db
        .update(purchaseObservations)
        .set({
          ...input.changes,
          manuallyCorrected: financialChange || row.manuallyCorrected,
          review: 'needs_review',
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(purchaseObservations.userId, userId), eq(purchaseObservations.id, row.id)))
        .returning();
      await new AuditService(db).log(
        userId,
        'review',
        'purchase_observation',
        row.id,
        row,
        updated,
      );
      return (await service.decorate(userId, [updated]))[0];
    });
  }

  async accept(userId: string, rawInput: z.input<typeof purchaseAcceptSchema>) {
    const input = purchaseAcceptSchema.parse(rawInput);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new PurchaseInboxService(db);
      const row = await service.owned(userId, input.observationId, input.version);
      if (await service.activeLink(userId, row.id))
        throw new TRPCError({ code: 'CONFLICT', message: 'Purchase is already applied' });
      if (
        !row.cardAccountId ||
        row.confirmation === 'retracted' ||
        row.unrecognized ||
        row.currency !== 'BRL' ||
        row.review === 'ignored'
      )
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Review card, currency and purchase status before applying',
        });
      let value: ReturnType<typeof purchaseApplicationAmounts>;
      try {
        value = purchaseApplicationAmounts(row);
      } catch (error) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: error instanceof Error ? error.message : 'Review amount',
        });
      }
      if (row.kind === 'refund' && value.totalInstallments > 1)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Review refund as one credit',
        });
      if (
        !input.confirmDistinct &&
        ((await service.candidates(userId, row)).length > 0 ||
          (await new PluggyCardReconciliationService(db).relatedPurchases(userId, row.id)).length >
            0)
      )
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Review possible existing purchases or confirm a distinct purchase',
        });
      const [expense] = await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, input.expenseAccountId),
            eq(accounts.userId, userId),
            eq(accounts.type, 'expense'),
            eq(accounts.isActive, true),
          ),
        );
      if (!expense)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Expense account not found' });
      await assertOpenSettlementPeriods(db, userId, [
        `${input.billingYear}-${String(input.billingMonth).padStart(2, '0')}-01`,
      ]);
      await new PluggyCardReconciliationService(db).applyReviewedCycle(
        userId,
        row.id,
        row.cardAccountId,
        input.billingMonth,
        input.billingYear,
      );
      const flow = new CreditCardFlowService(db, { capturePurchases: false });
      const common = {
        creditCardAccountId: row.cardAccountId,
        expenseAccountId: expense.id,
        description: row.description,
        amount: value.installmentAmount,
        categoryId: row.categoryId ?? undefined,
        purchaseDate: row.purchaseDate,
        purchaseDateSource: row.purchaseDate ? ('user' as const) : undefined,
      };
      let target: { scheduleId: string } | { transactionId: string };
      if (value.totalInstallments > 1) {
        const created = await flow.addInstallment(userId, {
          ...common,
          totalInstallments: value.totalInstallments,
          currentInstallmentNumber: value.installmentNumber,
          currentBillingMonth: input.billingMonth,
          currentBillingYear: input.billingYear,
        });
        target = { scheduleId: created.schedule.id };
      } else {
        const single = {
          ...common,
          billingMonth: input.billingMonth,
          billingYear: input.billingYear,
          postedDate: row.postedDate,
          postedDateSource: row.postedDate ? ('user' as const) : undefined,
        };
        const created =
          row.kind === 'refund'
            ? await flow.addRefund(userId, single)
            : await flow.addOneTimeExpense(userId, single);
        target = { transactionId: created.transaction.id };
      }
      const id = await new FinancialEventService(db).attach(userId, row.id, target, 'created');
      return (await service.detail(userId, id)).purchase;
    });
  }

  async link(userId: string, rawInput: z.input<typeof purchaseLinkSchema>) {
    const input = purchaseLinkSchema.parse(rawInput);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new PurchaseInboxService(db);
      await service.owned(userId, input.observationId, input.version);
      const id = await new FinancialEventService(db).attach(
        userId,
        input.observationId,
        input.target,
      );
      return (await service.detail(userId, id)).purchase;
    });
  }

  async separateEvidence(userId: string, rawInput: z.input<typeof purchaseSeparateEvidenceSchema>) {
    const input = purchaseSeparateEvidenceSchema.parse(rawInput);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new PurchaseInboxService(db);
      const canonical = await service.owned(userId, input.observationId, input.version);
      const events = await db
        .select()
        .from(financialEvents)
        .where(
          and(eq(financialEvents.userId, userId), eq(financialEvents.observationId, canonical.id)),
        )
        .for('update');
      const selected = events.find((event) => event.id === input.eventId);
      if (!selected) throw new TRPCError({ code: 'NOT_FOUND', message: 'Evidence not found' });
      if (events.length < 2)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The purchase must retain its original evidence',
        });
      const [revision] = await db
        .select()
        .from(financialEventRevisions)
        .where(
          and(
            eq(financialEventRevisions.userId, userId),
            eq(financialEventRevisions.eventId, selected.id),
            eq(financialEventRevisions.sourceVersion, selected.currentVersion),
          ),
        );
      if (!revision)
        throw new TRPCError({ code: 'CONFLICT', message: 'Current evidence not found' });
      const [separated] = await db
        .insert(purchaseObservations)
        .values({
          userId,
          ...revision.data,
          review: 'needs_review',
        })
        .returning();
      await db
        .update(financialEvents)
        .set({ observationId: separated.id })
        .where(and(eq(financialEvents.userId, userId), eq(financialEvents.id, selected.id)));
      const confirmation = await loadPurchaseConfirmation(db, userId, canonical.id);
      await db
        .update(purchaseObservations)
        .set({
          confirmation,
          version: canonical.version + 1,
          updatedAt: new Date(),
          review: canonical.review === 'ignored' ? 'ignored' : 'needs_review',
        })
        .where(
          and(eq(purchaseObservations.userId, userId), eq(purchaseObservations.id, canonical.id)),
        );
      await new AuditService(db).log(
        userId,
        'separate_evidence',
        'purchase_observation',
        canonical.id,
        { eventId: selected.id, observationId: canonical.id },
        { eventId: selected.id, observationId: separated.id },
      );
      return (await service.decorate(userId, [separated]))[0];
    });
  }

  private async decision(
    userId: string,
    rawInput: Version,
    action: 'ignore' | 'reprocess' | 'unlink',
  ) {
    const input = purchaseVersionSchema.parse(rawInput);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new PurchaseInboxService(db);
      const row = await service.owned(userId, input.observationId, input.version);
      if (action === 'unlink')
        await db
          .update(purchaseLedgerLinks)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(purchaseLedgerLinks.userId, userId),
              eq(purchaseLedgerLinks.observationId, row.id),
              isNull(purchaseLedgerLinks.revokedAt),
            ),
          );
      const [updated] = await db
        .update(purchaseObservations)
        .set({
          review: action === 'ignore' ? 'ignored' : 'needs_review',
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(purchaseObservations.userId, userId), eq(purchaseObservations.id, row.id)))
        .returning();
      await new AuditService(db).log(
        userId,
        action,
        'purchase_observation',
        row.id,
        { review: row.review, version: row.version },
        { review: updated.review, version: updated.version },
      );
      return (await service.decorate(userId, [updated]))[0];
    });
  }
  ignore(userId: string, input: Version) {
    return this.decision(userId, input, 'ignore');
  }
  reprocess(userId: string, input: Version) {
    return this.decision(userId, input, 'reprocess');
  }
  unlink(userId: string, input: Version) {
    return this.decision(userId, input, 'unlink');
  }
}
