import type { DbExecutor } from '@fc/db';
import { accounts, scheduledTransactions, transactions } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';

export type ArchiveBlockedReason = 'CURRENT_BILL' | 'FUTURE_COMMITMENTS';

export type ArchiveEligibility = {
  canArchive: boolean;
  blockedReason: ArchiveBlockedReason | null;
};

type GroupCurrentTotal = {
  rootId: string;
  currentBillTotal: number;
};

type CardAccount = typeof accounts.$inferSelect;

export type CreditCardGroup = {
  root: CardAccount;
  members: CardAccount[];
};

export class CreditCardLifecycleService {
  constructor(
    private db: DbExecutor,
    private now: () => Date = () => new Date(),
  ) {}

  async resolveGroup(userId: string, cardAccountId: string): Promise<CreditCardGroup> {
    const [requested] = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.id, cardAccountId),
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
        ),
      );

    if (!requested) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'CARD_NOT_FOUND' });
    }

    const rootId = requested.parentAccountId ?? requested.id;
    const [root] = await this.db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.id, rootId), eq(accounts.userId, userId), eq(accounts.type, 'credit_card')),
      );

    if (!root) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'CARD_NOT_FOUND' });
    }

    const members = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
          or(eq(accounts.id, root.id), eq(accounts.parentAccountId, root.id)),
        ),
      )
      .orderBy(asc(accounts.parentAccountId), asc(accounts.name));

    return { root, members };
  }

  async getArchiveEligibility(userId: string, cardAccountId: string): Promise<ArchiveEligibility> {
    const group = await this.resolveGroup(userId, cardAccountId);
    return this.getGroupEligibility(
      userId,
      group.members.map((member) => member.id),
    );
  }

  async getArchiveEligibilityForGroups(
    userId: string,
    groups: GroupCurrentTotal[],
  ): Promise<Map<string, ArchiveEligibility>> {
    if (groups.length === 0) return new Map();

    const rootIds = groups.map((group) => group.rootId);
    const cards = await this.db
      .select({ id: accounts.id, parentAccountId: accounts.parentAccountId })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
          or(inArray(accounts.id, rootIds), inArray(accounts.parentAccountId, rootIds)),
        ),
      );
    const rootByCardId = new Map(
      cards.map((card) => [card.id, card.parentAccountId ?? card.id] as const),
    );
    const cardIds = cards.map((card) => card.id);
    const today = this.now();
    const month = today.getMonth() + 1;
    const year = today.getFullYear();
    const currentOrdinal = year * 12 + month;

    const [futureTransactions, indefiniteSchedules] = await Promise.all([
      this.db
        .select({ cardId: transactions.destinationAccountId })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(transactions.destinationAccountId, cardIds),
            eq(transactions.isReversed, false),
            or(ne(transactions.domainType, 'bill_payment'), isNull(transactions.domainType)),
            sql`(${transactions.billingYear} * 12 + ${transactions.billingMonth}) > ${currentOrdinal}`,
          ),
        ),
      this.db
        .select({ cardId: scheduledTransactions.destinationAccountId })
        .from(scheduledTransactions)
        .where(
          and(
            eq(scheduledTransactions.userId, userId),
            inArray(scheduledTransactions.destinationAccountId, cardIds),
            eq(scheduledTransactions.isActive, true),
            isNull(scheduledTransactions.totalOccurrences),
            or(
              isNull(scheduledTransactions.endDate),
              gte(scheduledTransactions.endDate, new Date(year, month - 1, today.getDate())),
            ),
          ),
        ),
    ]);

    const futureRootIds = new Set<string>();
    for (const row of [...futureTransactions, ...indefiniteSchedules]) {
      const rootId = rootByCardId.get(row.cardId);
      if (rootId) futureRootIds.add(rootId);
    }

    return new Map(
      groups.map(({ rootId, currentBillTotal }) => {
        const eligibility: ArchiveEligibility =
          currentBillTotal !== 0
            ? { canArchive: false, blockedReason: 'CURRENT_BILL' }
            : futureRootIds.has(rootId)
              ? { canArchive: false, blockedReason: 'FUTURE_COMMITMENTS' }
              : { canArchive: true, blockedReason: null };
        return [rootId, eligibility];
      }),
    );
  }

  async listArchivedGroups(userId: string) {
    const archivedCards = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
          eq(accounts.isActive, false),
        ),
      )
      .orderBy(asc(accounts.name));

    const roots = archivedCards.filter((card) => card.parentAccountId === null);
    return roots.map((root) => ({
      root: {
        id: root.id,
        name: root.name,
        color: root.color,
      },
      members: archivedCards
        .filter((card) => card.id === root.id || card.parentAccountId === root.id)
        .map((card) => ({
          id: card.id,
          name: card.name,
          color: card.color,
          isPrincipal: card.id === root.id,
        })),
    }));
  }

  async archiveGroup(userId: string, cardAccountId: string) {
    return this.db.transaction(async (tx) => {
      const lifecycle = new CreditCardLifecycleService(tx, this.now);
      const group = await lifecycle.resolveGroup(userId, cardAccountId);
      const memberIds = group.members.map((member) => member.id);

      await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.userId, userId), inArray(accounts.id, memberIds)))
        .for('update');

      const eligibility = await lifecycle.getGroupEligibility(userId, memberIds);
      if (!eligibility.canArchive) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: eligibility.blockedReason ?? 'CARD_NOT_ARCHIVABLE',
        });
      }

      await tx
        .update(accounts)
        .set({ isActive: false, updatedAt: this.now() })
        .where(and(eq(accounts.userId, userId), inArray(accounts.id, memberIds)));

      return { rootId: group.root.id, memberIds };
    });
  }

  async reactivateGroup(userId: string, cardAccountId: string) {
    return this.db.transaction(async (tx) => {
      const lifecycle = new CreditCardLifecycleService(tx, this.now);
      const group = await lifecycle.resolveGroup(userId, cardAccountId);
      const memberIds = group.members.map((member) => member.id);

      await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.userId, userId), inArray(accounts.id, memberIds)))
        .for('update');

      await tx
        .update(accounts)
        .set({ isActive: true, updatedAt: this.now() })
        .where(and(eq(accounts.userId, userId), inArray(accounts.id, memberIds)));

      return { rootId: group.root.id, memberIds };
    });
  }

  async assertActiveCard(userId: string, cardAccountId: string) {
    const group = await this.resolveGroup(userId, cardAccountId);
    if (group.members.some((member) => !member.isActive)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'CARD_ARCHIVED' });
    }
    return group;
  }

  private async getGroupEligibility(
    userId: string,
    memberIds: string[],
  ): Promise<ArchiveEligibility> {
    const today = this.now();
    const month = today.getMonth() + 1;
    const year = today.getFullYear();
    const currentOrdinal = year * 12 + month;

    const [[currentBill], [futureTransaction], [indefiniteSchedule]] = await Promise.all([
      this.db
        .select({
          total: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.domainType} = 'credit_card_refund' THEN -${transactions.amount} ELSE ${transactions.amount} END), 0)`,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(transactions.destinationAccountId, memberIds),
            eq(transactions.billingMonth, month),
            eq(transactions.billingYear, year),
            eq(transactions.isReversed, false),
            or(ne(transactions.domainType, 'bill_payment'), isNull(transactions.domainType)),
          ),
        ),
      this.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(transactions.destinationAccountId, memberIds),
            eq(transactions.isReversed, false),
            or(ne(transactions.domainType, 'bill_payment'), isNull(transactions.domainType)),
            sql`(${transactions.billingYear} * 12 + ${transactions.billingMonth}) > ${currentOrdinal}`,
          ),
        )
        .limit(1),
      this.db
        .select({ id: scheduledTransactions.id })
        .from(scheduledTransactions)
        .where(
          and(
            eq(scheduledTransactions.userId, userId),
            inArray(scheduledTransactions.destinationAccountId, memberIds),
            eq(scheduledTransactions.isActive, true),
            isNull(scheduledTransactions.totalOccurrences),
            or(
              isNull(scheduledTransactions.endDate),
              gte(scheduledTransactions.endDate, new Date(year, month - 1, today.getDate())),
            ),
          ),
        )
        .limit(1),
    ]);

    if (Number(currentBill?.total ?? 0) !== 0) {
      return { canArchive: false, blockedReason: 'CURRENT_BILL' };
    }
    if (futureTransaction || indefiniteSchedule) {
      return { canArchive: false, blockedReason: 'FUTURE_COMMITMENTS' };
    }
    return { canArchive: true, blockedReason: null };
  }
}
