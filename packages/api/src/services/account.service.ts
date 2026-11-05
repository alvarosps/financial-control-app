import type { DbExecutor } from '@fc/db';
import { accounts, transactions } from '@fc/db';
import type { AccountType } from '@fc/domain';
import { NotFoundError } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, asc, count, eq, or, sql } from 'drizzle-orm';
import { financialRevision } from '../lib/financial-revision.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import type { PaginatedResult, PaginationInput } from '../lib/pagination.ts';
import { paginate } from '../lib/pagination.ts';
import { assertOpenSettlementPeriods, settlementDateKey } from '../lib/settlement-guards.ts';
import { AuditService } from './audit.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

type CreateAccountInput = {
  name: string;
  type: AccountType;
  currency: string;
  icon?: string;
  color?: string;
  overdraftLimit?: string;
  cdiPercentage?: string;
  parentAccountId?: string;
};

type UpdateAccountInput = {
  name?: string;
  icon?: string;
  color?: string;
  overdraftLimit?: string;
  cdiPercentage?: string;
  sortOrder?: number;
};

type AccountRow = typeof accounts.$inferSelect;

export class AccountService {
  constructor(private db: DbExecutor) {}

  async create(userId: string, input: CreateAccountInput) {
    const [account] = await this.db
      .insert(accounts)
      .values({
        userId,
        name: input.name,
        type: input.type,
        currency: input.currency,
        openingBalanceAnchorAt: new Date(),
        ...(input.icon !== undefined && { icon: input.icon }),
        ...(input.color !== undefined && { color: input.color }),
        ...(input.overdraftLimit !== undefined && { overdraftLimit: input.overdraftLimit }),
        ...(input.cdiPercentage !== undefined && { cdiPercentage: input.cdiPercentage }),
        ...(input.parentAccountId !== undefined && { parentAccountId: input.parentAccountId }),
      })
      .returning();

    return account;
  }

  listByUser(userId: string): Promise<AccountRow[]>;
  listByUser(userId: string, page: number, pageSize?: number): Promise<PaginatedResult<AccountRow>>;
  async listByUser(userId: string, page?: number, pageSize?: number) {
    const whereCondition = and(eq(accounts.userId, userId), eq(accounts.isActive, true));

    if (page === undefined) {
      return this.db
        .select()
        .from(accounts)
        .where(whereCondition)
        .orderBy(asc(accounts.sortOrder), asc(accounts.name));
    }

    const pagination: PaginationInput = { page, pageSize: pageSize ?? 100 };
    const offset = (pagination.page - 1) * pagination.pageSize;

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(accounts)
        .where(whereCondition)
        .orderBy(asc(accounts.sortOrder), asc(accounts.name))
        .limit(pagination.pageSize)
        .offset(offset),
      this.db.select({ total: count() }).from(accounts).where(whereCondition),
    ]);

    return paginate(items, total, pagination);
  }

  /**
   * Map of parentCardId → [active child credit_card ids]. Used to consolidate
   * additional cards into their parent for bill/spending aggregation.
   */
  async getCreditCardChildrenMap(userId: string): Promise<Map<string, string[]>> {
    const cards = await this.db
      .select({ id: accounts.id, parentAccountId: accounts.parentAccountId })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
          eq(accounts.isActive, true),
        ),
      );
    const map = new Map<string, string[]>();
    for (const c of cards) {
      if (c.parentAccountId) {
        const arr = map.get(c.parentAccountId) ?? [];
        arr.push(c.id);
        map.set(c.parentAccountId, arr);
      }
    }
    return map;
  }

  async getById(userId: string, accountId: string) {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));

    if (!account) {
      throw new NotFoundError('Conta não encontrada');
    }

    return account;
  }

  async update(userId: string, accountId: string, input: UpdateAccountInput) {
    const target = await this.getById(userId, accountId);
    if (target.type === 'credit_card' && !target.isActive) {
      throw new TRPCError({ code: 'CONFLICT', message: 'CARD_ARCHIVED' });
    }

    const [updated] = await this.db
      .update(accounts)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.icon !== undefined && { icon: input.icon }),
        ...(input.color !== undefined && { color: input.color }),
        ...(input.overdraftLimit !== undefined && { overdraftLimit: input.overdraftLimit }),
        ...(input.cdiPercentage !== undefined && { cdiPercentage: input.cdiPercentage }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(accounts.id, accountId),
          eq(accounts.userId, userId),
          target.type === 'credit_card' ? eq(accounts.isActive, true) : undefined,
        ),
      )
      .returning();

    if (!updated) {
      if (target.type === 'credit_card') {
        throw new TRPCError({ code: 'CONFLICT', message: 'CARD_ARCHIVED' });
      }
      throw new NotFoundError('Conta não encontrada');
    }

    return updated;
  }

  async deactivate(userId: string, accountId: string) {
    const [updated] = await this.db
      .update(accounts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
      .returning();

    if (!updated) {
      throw new NotFoundError('Conta não encontrada');
    }

    return updated;
  }

  async recalculateBalance(accountId: string) {
    // Delegates to the DB SQL function recalculate_account_balance (migration 0004),
    // which is also invoked by trg_recalculate_balance on every transaction mutation.
    // This keeps application code and DB triggers using a single source of truth.
    await this.db.execute(sql`SELECT recalculate_account_balance(${accountId}::uuid)`);
    const [row] = await this.db
      .select({ balance: accounts.currentBalance })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    return row?.balance ?? '0.00';
  }

  /** Active checking accounts — the only accounts shown as "carteiras". */
  async listWallets(userId: string): Promise<AccountRow[]> {
    return this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.isActive, true),
          eq(accounts.type, 'checking'),
        ),
      )
      .orderBy(asc(accounts.sortOrder), asc(accounts.name));
  }

  async getDefaultWallet(userId: string): Promise<AccountRow | undefined> {
    const [row] = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.isActive, true),
          eq(accounts.type, 'checking'),
          eq(accounts.isDefaultWallet, true),
        ),
      );
    return row;
  }

  /**
   * Re-anchor a transaction wallet so its real cash becomes exactly `newCash`.
   * Sets `openingBalance = newCash` AND `openingBalanceAnchorAt = now()` in one
   * atomic update: with no movements settled after the new anchor, the canonical
   * cash (`opening + Σ(paid, paid_at > anchor)`) equals `newCash`. Both columns
   * MUST move together — leaving the old anchor would double-count every movement
   * settled since it. (This is why the generic `update` cannot be used.)
   */
  async balanceAdjustmentPreview(userId: string, accountId: string) {
    const wallet = await this.getById(userId, accountId);
    if (!wallet.isActive || wallet.type !== 'checking' || wallet.currency !== 'BRL')
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Select an active BRL checking account',
      });
    const movements = await this.db
      .select({ id: transactions.id, updatedAt: transactions.updatedAt })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          or(
            eq(transactions.sourceAccountId, accountId),
            eq(transactions.destinationAccountId, accountId),
            eq(transactions.paidFromAccountId, accountId),
          ),
        ),
      )
      .orderBy(transactions.id);
    const cash = (await new WalletCashService(this.db).getWalletCash(userId)).wallets.find(
      (w) => w.id === accountId,
    )?.cash;
    return {
      walletId: accountId,
      name: wallet.name,
      cash: cash ?? Number(wallet.openingBalance),
      anchorAt: wallet.openingBalanceAnchorAt,
      revision: financialRevision({ wallet, movements, cash }),
    };
  }

  async reanchorWallet(
    userId: string,
    accountId: string,
    newCash: string,
    review?: { expectedRevision: string; reason: string },
  ): Promise<AccountRow> {
    return runWithMaterializationLock(this.db, userId, async ({ db }) =>
      new AccountService(db).reanchorLocked(userId, accountId, newCash, review),
    );
  }

  private async reanchorLocked(
    userId: string,
    accountId: string,
    newCash: string,
    review?: { expectedRevision: string; reason: string },
  ): Promise<AccountRow> {
    await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .for('update');
    const preview = await this.balanceAdjustmentPreview(userId, accountId);
    if (review && preview.revision !== review.expectedRevision)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Balance changed. Reload the preview before adjusting.',
      });
    const target = await this.getById(userId, accountId);
    if (target.type !== 'checking') {
      throw new NotFoundError('Conta não é uma carteira de transação');
    }
    if (target.currency !== 'BRL') {
      throw new NotFoundError('Re-âncora de saldo disponível apenas para carteiras em BRL');
    }
    const now = new Date();
    await assertOpenSettlementPeriods(this.db, userId, [settlementDateKey(now)]);
    const [updated] = await this.db
      .update(accounts)
      .set({
        openingBalance: newCash,
        openingBalanceAnchorAt: now,
        updatedAt: now,
      })
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
      .returning();
    await new AuditService(this.db).log(
      userId,
      'wallet_balance_adjustment',
      'account',
      accountId,
      { wallet: target, cash: preview.cash },
      {
        wallet: updated,
        reason: review?.reason ?? 'Balance adjustment',
        recordedAt: now.toISOString(),
      },
    );
    return updated;
  }

  /** Make `accountId` the sole default wallet for the user (must be checking). */
  async setDefaultWallet(userId: string, accountId: string): Promise<AccountRow> {
    const target = await this.getById(userId, accountId);
    if (target.type !== 'checking') {
      throw new NotFoundError('Conta não é uma carteira de transação');
    }
    return this.db.transaction(async (tx) => {
      await tx
        .update(accounts)
        .set({ isDefaultWallet: false, updatedAt: new Date() })
        .where(and(eq(accounts.userId, userId), eq(accounts.isDefaultWallet, true)));
      const [updated] = await tx
        .update(accounts)
        .set({ isDefaultWallet: true, updatedAt: new Date() })
        .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
        .returning();
      return updated;
    });
  }
}
