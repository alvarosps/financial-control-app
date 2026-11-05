import { createHash } from 'node:crypto';
import type { DbExecutor } from '@fc/db';
import {
  accounts,
  bankReconciliationLinks,
  externalAccounts,
  externalMovements,
  transactions,
} from '@fc/db';
import { Money } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { cashMovementDay, cashValueBrl } from '../lib/cash-selection.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { assertOpenSettlementPeriods, settlementDateKey } from '../lib/settlement-guards.ts';
import { AuditService } from './audit.service.ts';
import { pluggyTransactionSchema } from './pluggy/pluggy-types.ts';
import { WalletCashService } from './wallet-cash.service.ts';

export const bankReviewSchema = z.object({
  movementId: z.guid(),
  version: z.number().int().positive(),
});
export const bankLinkSchema = bankReviewSchema.extend({
  allocations: z
    .array(
      z.object({
        transactionId: z.guid(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(50),
});
export const bankUnlinkSchema = bankReviewSchema.extend({
  reason: z.string().trim().min(3).max(500),
});
type LedgerRow = typeof transactions.$inferSelect;
function fingerprint(row: LedgerRow) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: row.id,
        source: row.sourceAccountId,
        destination: row.destinationAccountId,
        amount: row.amount,
        currency: row.currency,
        cash: row.cashAmount,
        paid: row.isPaid,
        paidAt: row.paidAt,
        settled: row.settlementDate,
        sourceType: row.settlementSource,
        reversed: row.isReversed,
        reverses: row.reversesTransactionId,
        domain: row.domainType,
        date: row.date,
        month: row.billingMonth,
        year: row.billingYear,
      }),
    )
    .digest('hex');
}
function periods(row: LedgerRow) {
  return [
    row.date.toISOString().slice(0, 10),
    ...(row.settlementDate ? [settlementDateKey(row.settlementDate)] : []),
    ...(row.billingMonth && row.billingYear
      ? [`${row.billingYear}-${String(row.billingMonth).padStart(2, '0')}-01`]
      : []),
  ];
}
export class BankReconciliationService {
  constructor(private db: DbExecutor) {}
  private async owned(userId: string, movementId: string) {
    const [row] = await this.db
      .select({ movement: externalMovements, account: externalAccounts })
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
          eq(externalMovements.id, movementId),
          eq(externalAccounts.kind, 'BANK'),
        ),
      );
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Bank movement not found' });
    const data = pluggyTransactionSchema.parse(row.movement.payload);
    if (data.id !== row.movement.externalId || data.accountId !== row.account.externalId)
      throw new TRPCError({ code: 'CONFLICT', message: 'Bank evidence scope mismatch' });
    return { ...row, data };
  }
  async list(userId: string, input: { externalAccountId: string; cursor?: string }) {
    const [account] = await this.db
      .select()
      .from(externalAccounts)
      .where(
        and(
          eq(externalAccounts.userId, userId),
          eq(externalAccounts.id, input.externalAccountId),
          eq(externalAccounts.kind, 'BANK'),
        ),
      );
    if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Bank account not found' });
    const rows = await this.db
      .select()
      .from(externalMovements)
      .where(
        and(
          eq(externalMovements.userId, userId),
          eq(externalMovements.externalAccountId, account.id),
          input.cursor ? lt(externalMovements.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(externalMovements.id))
      .limit(51);
    const items = await Promise.all(
      rows.slice(0, 50).map(async (row) => {
        const detail = await this.detail(userId, row.id);
        return { id: row.id, version: row.version, ...detail.movement, state: detail.state };
      }),
    );
    return { items, nextCursor: rows.length > 50 ? rows[49].id : null };
  }
  async closingEvidence(userId: string, start: string, end: string) {
    return this.evidence(
      userId,
      sql`(substring(${externalMovements.payload}->>'date',1,10) BETWEEN ${start} AND ${end} OR ${externalMovements.payload}->>'date' IS NULL OR EXISTS (SELECT 1 FROM bank_reconciliation_links l JOIN transactions t ON t.id=l.transaction_id AND t.user_id=${userId} WHERE l.user_id=${userId} AND l.movement_id=${externalMovements.id} AND l.revoked_at IS NULL AND cash_movement_day(t.date,t.settlement_date) BETWEEN ${start}::date AND ${end}::date))`,
    );
  }
  async cashEvidence(userId: string, wallets: { id: string; anchorAt: Date }[], asOf: Date) {
    if (!wallets.length) return { items: [], truncated: false };
    const end = settlementDateKey(asOf);
    const earliest = wallets.reduce(
      (start, wallet) => (wallet.anchorAt < start ? wallet.anchorAt : start),
      wallets[0].anchorAt,
    );
    // A bank date without a time cannot establish whether an anchor-day debit was included.
    const window = (anchor: Date) =>
      sql`(substring(${externalMovements.payload}->>'date',1,10) BETWEEN ${settlementDateKey(anchor)} AND ${end} OR ${externalMovements.payload}->>'date' IS NULL)`;
    return this.evidence(
      userId,
      or(
        ...wallets.map(
          (
            wallet,
          ) => sql`((${externalAccounts.accountId}=${wallet.id} AND ${window(wallet.anchorAt)}) OR EXISTS (
        SELECT 1 FROM bank_reconciliation_links l JOIN transactions t ON t.id=l.transaction_id AND t.user_id=${userId}
        WHERE l.user_id=${userId} AND l.movement_id=${externalMovements.id} AND l.wallet_account_id=${wallet.id}
          AND l.revoked_at IS NULL AND t.settlement_date > ${wallet.anchorAt.toISOString()}::timestamptz
          AND t.settlement_date <= ${asOf.toISOString()}::timestamptz
      ))`,
        ),
        and(isNull(externalAccounts.accountId), window(earliest)),
      ),
    );
  }
  private async evidence(userId: string, periodFilter: SQL | undefined) {
    const rows = await this.db
      .select({ id: externalMovements.id })
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
          eq(externalAccounts.kind, 'BANK'),
          periodFilter,
          sql`(${externalMovements.retractedAt} IS NULL OR EXISTS (SELECT 1 FROM bank_reconciliation_links l WHERE l.user_id=${userId} AND l.movement_id=${externalMovements.id} AND l.revoked_at IS NULL))`,
        ),
      )
      .orderBy(externalMovements.id)
      .limit(251);
    const items = await Promise.all(
      rows.slice(0, 250).map((row) => this.detail(userId, row.id, false)),
    );
    return { items, truncated: rows.length > 250 };
  }
  async detail(userId: string, movementId: string, includeCandidates = true) {
    const { movement, account, data } = await this.owned(userId, movementId);
    const links = await this.db
      .select({ link: bankReconciliationLinks, transaction: transactions })
      .from(bankReconciliationLinks)
      .innerJoin(
        transactions,
        and(
          eq(transactions.id, bankReconciliationLinks.transactionId),
          eq(transactions.userId, userId),
        ),
      )
      .where(
        and(
          eq(bankReconciliationLinks.userId, userId),
          eq(bankReconciliationLinks.movementId, movementId),
          isNull(bankReconciliationLinks.revokedAt),
        ),
      );
    const amount = Money.fromNumber(data.amount, data.currencyCode).abs().toDbString();
    const reviewable =
      account.accountId !== null &&
      data.currencyCode === 'BRL' &&
      account.currency === 'BRL' &&
      (data.type === 'CREDIT' || data.type === 'DEBIT') &&
      data.status === 'POSTED' &&
      movement.retractedAt === null &&
      amount !== '0.00';
    const date = data.date.slice(0, 10);
    const rows =
      reviewable && includeCandidates
        ? await this.db
            .select({ row: transactions, cash: cashValueBrl, day: cashMovementDay })
            .from(transactions)
            .where(
              and(
                eq(transactions.userId, userId),
                data.type === 'DEBIT'
                  ? eq(transactions.sourceAccountId, account.accountId as string)
                  : eq(transactions.destinationAccountId, account.accountId as string),
                sql`${transactions.sourceAccountId} <> ${transactions.destinationAccountId}`,
                sql`wallet_cash_in_window(${transactions}, '1970-01-01'::timestamptz, 'recorded', '2200-12-31'::timestamptz)`,
                sql`${cashMovementDay} BETWEEN ${date}::date - 3 AND ${date}::date + 3`,
                sql`${cashValueBrl} > 0 AND ${cashValueBrl} <= ${amount}::numeric`,
                sql`NOT EXISTS (SELECT 1 FROM bank_reconciliation_links l WHERE l.user_id=${userId} AND l.wallet_account_id=${account.accountId} AND l.transaction_id=${transactions.id} AND l.revoked_at IS NULL)`,
              ),
            )
            .orderBy(transactions.id)
            .limit(251)
        : [];
    const stale =
      links.some(
        ({ link, transaction }) =>
          link.movementVersion !== movement.version ||
          link.transactionFingerprint !== fingerprint(transaction),
      ) || !reviewable;
    return {
      id: movementId,
      version: movement.version,
      state: links.length ? (stale ? 'needs_review' : 'linked') : 'pending',
      reviewable,
      movement: {
        description: data.description,
        amount,
        currency: data.currencyCode,
        date,
        type: data.type,
        status: data.status,
        retractedAt: movement.retractedAt,
      },
      candidates: rows.slice(0, 250).map(({ row, cash, day }) => ({
        transactionId: row.id,
        description: row.description,
        domainType: row.domainType,
        amount: Money.fromString(cash ?? '0', 'BRL').toDbString(),
        date: day,
        fingerprint: fingerprint(row),
      })),
      candidatesTruncated: rows.length > 250,
      links: links.map(({ link, transaction }) => ({
        id: link.id,
        transactionId: transaction.id,
        description: transaction.description,
        amount: link.amount,
        stale:
          link.transactionFingerprint !== fingerprint(transaction) ||
          link.movementVersion !== movement.version,
      })),
    };
  }
  async link(userId: string, raw: z.input<typeof bankLinkSchema>) {
    const input = bankLinkSchema.parse(raw);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new BankReconciliationService(db);
      await db
        .select({ id: externalMovements.id })
        .from(externalMovements)
        .where(
          and(eq(externalMovements.userId, userId), eq(externalMovements.id, input.movementId)),
        )
        .for('update');
      const { movement, account, data } = await service.owned(userId, input.movementId);
      if (movement.version !== input.version)
        throw new TRPCError({ code: 'CONFLICT', message: 'Bank evidence changed; review again' });
      const selected = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(
              transactions.id,
              input.allocations.map((a) => a.transactionId),
            ),
          ),
        )
        .orderBy(transactions.id)
        .for('update');
      const detail = await service.detail(userId, input.movementId);
      if (!detail.reviewable || detail.links.length || selected.length !== input.allocations.length)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Review available bank movements and distinct payments',
        });
      let sum = Money.zero('BRL');
      for (const allocation of input.allocations) {
        const candidate = detail.candidates.find(
          (c) =>
            c.transactionId === allocation.transactionId &&
            c.fingerprint === allocation.fingerprint,
        );
        if (!candidate)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Payment changed or unavailable; review again',
          });
        sum = sum.add(Money.fromString(candidate.amount, 'BRL'));
      }
      if (sum.toDbString() !== detail.movement.amount)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Full allocations must equal the bank movement; partial payment remains pending',
        });
      await assertOpenSettlementPeriods(db, userId, [
        data.date.slice(0, 10),
        ...selected.flatMap(periods),
      ]);
      if (!account.accountId)
        throw new TRPCError({ code: 'CONFLICT', message: 'Map the bank account first' });
      await db.insert(bankReconciliationLinks).values(
        selected.map((row) => ({
          userId,
          movementId: movement.id,
          movementVersion: movement.version,
          walletAccountId: account.accountId as string,
          transactionId: row.id,
          transactionFingerprint: fingerprint(row),
          amount: row.cashAmount ?? row.amount,
        })),
      );
      await db
        .update(externalMovements)
        .set({ reviewedVersion: movement.version })
        .where(and(eq(externalMovements.userId, userId), eq(externalMovements.id, movement.id)));
      await new AuditService(db).log(userId, 'link', 'bank_reconciliation', movement.id, null, {
        version: movement.version,
        transactionIds: selected.map((row) => row.id),
        amount: sum.toDbString(),
      });
      return service.detail(userId, movement.id);
    });
  }
  async unlink(userId: string, raw: z.input<typeof bankUnlinkSchema>) {
    const input = bankUnlinkSchema.parse(raw);
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const service = new BankReconciliationService(db);
      const { movement, data } = await service.owned(userId, input.movementId);
      if (movement.version !== input.version)
        throw new TRPCError({ code: 'CONFLICT', message: 'Bank evidence changed; review again' });
      const links = await db
        .select({ link: bankReconciliationLinks, transaction: transactions })
        .from(bankReconciliationLinks)
        .innerJoin(
          transactions,
          and(
            eq(transactions.id, bankReconciliationLinks.transactionId),
            eq(transactions.userId, userId),
          ),
        )
        .where(
          and(
            eq(bankReconciliationLinks.userId, userId),
            eq(bankReconciliationLinks.movementId, movement.id),
            isNull(bankReconciliationLinks.revokedAt),
          ),
        );
      if (!links.length)
        throw new TRPCError({ code: 'CONFLICT', message: 'No active reconciliation' });
      await assertOpenSettlementPeriods(db, userId, [
        data.date.slice(0, 10),
        ...links.flatMap((row) => periods(row.transaction)),
      ]);
      await db
        .update(bankReconciliationLinks)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(bankReconciliationLinks.userId, userId),
            eq(bankReconciliationLinks.movementId, movement.id),
            isNull(bankReconciliationLinks.revokedAt),
          ),
        );
      await db
        .update(externalMovements)
        .set({ reviewedVersion: null })
        .where(and(eq(externalMovements.userId, userId), eq(externalMovements.id, movement.id)));
      await new AuditService(db).log(
        userId,
        'unlink',
        'bank_reconciliation',
        movement.id,
        { linkIds: links.map((row) => row.link.id) },
        { reason: input.reason },
      );
      return service.detail(userId, movement.id);
    });
  }
  async balance(userId: string, externalAccountId: string) {
    const [account] = await this.db
      .select()
      .from(externalAccounts)
      .where(
        and(
          eq(externalAccounts.userId, userId),
          eq(externalAccounts.id, externalAccountId),
          eq(externalAccounts.kind, 'BANK'),
        ),
      );
    if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Bank account not found' });
    const metadata = {
      institutional: account.balance,
      balanceType: account.balanceType,
      asOf: account.balanceAsOf,
      fetchedAt: account.fetchedAt,
    };
    const unavailable = (reason: string) => ({
      ...metadata,
      comparable: false as const,
      reason,
      calculated: null,
      difference: null,
    });
    if (account.balanceType === 'unknown') return unavailable('unknown_balance_type');
    if (account.balanceType !== 'book') return unavailable('non_book_balance');
    if (!account.balanceAsOf) return unavailable('unknown_balance_date');
    if (!account.accountId || account.currency !== 'BRL' || account.balance === null)
      return unavailable('unmapped_or_unsupported');
    const [wallet] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, account.accountId)));
    if (
      !wallet ||
      (wallet.openingBalanceAnchorAt && wallet.openingBalanceAnchorAt > account.balanceAsOf)
    )
      return unavailable('balance_precedes_anchor');
    const cash = (
      await new WalletCashService(this.db).getWalletCash(userId, account.balanceAsOf)
    ).wallets.find((row) => row.id === wallet.id);
    if (!cash) return unavailable('unmapped_or_unsupported');
    if (cash.legacyMovementCount || cash.unresolvedMovementCount || cash.assumedDelta !== 0)
      return unavailable('unresolved_cash');
    const calculated = Money.fromNumber(cash.cash, 'BRL');
    return {
      ...metadata,
      comparable: true as const,
      reason: null,
      calculated: calculated.toDbString(),
      difference: Money.fromString(account.balance, 'BRL').subtract(calculated).toDbString(),
    };
  }
}
