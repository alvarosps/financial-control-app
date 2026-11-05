import type { DbExecutor } from '@fc/db';
import { accounts, faturaMatchRules, scheduledTransactions } from '@fc/db';
import { normalizeMerchantText } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray } from 'drizzle-orm';

export class FaturaMatchRuleService {
  constructor(private readonly db: DbExecutor) {}

  async listForCards(userId: string, cardAccountIds: string[]) {
    if (cardAccountIds.length === 0) return [];
    return this.db
      .select({
        cardAccountId: faturaMatchRules.cardAccountId,
        rawNormalized: faturaMatchRules.rawNormalized,
        scheduleId: faturaMatchRules.targetScheduleId,
      })
      .from(faturaMatchRules)
      .innerJoin(
        scheduledTransactions,
        eq(scheduledTransactions.id, faturaMatchRules.targetScheduleId),
      )
      .where(
        and(
          eq(faturaMatchRules.userId, userId),
          inArray(faturaMatchRules.cardAccountId, cardAccountIds),
          eq(scheduledTransactions.userId, userId),
          inArray(scheduledTransactions.domainType, [
            'credit_card_fixed_charge',
            'credit_card_refund',
          ]),
          eq(scheduledTransactions.isActive, true),
        ),
      );
  }

  async learn(
    userId: string,
    input: { cardAccountId: string; rawDescription: string; scheduleId: string },
  ) {
    const rawNormalized = normalizeMerchantText(input.rawDescription);
    if (rawNormalized.length === 0) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Descrição da fatura inválida' });
    }
    const [owned] = await this.db
      .select({ scheduleId: scheduledTransactions.id })
      .from(scheduledTransactions)
      .innerJoin(accounts, eq(accounts.id, scheduledTransactions.destinationAccountId))
      .where(
        and(
          eq(scheduledTransactions.id, input.scheduleId),
          eq(scheduledTransactions.userId, userId),
          eq(scheduledTransactions.destinationAccountId, input.cardAccountId),
          inArray(scheduledTransactions.domainType, [
            'credit_card_fixed_charge',
            'credit_card_refund',
          ]),
          eq(scheduledTransactions.isActive, true),
          eq(accounts.id, input.cardAccountId),
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
        ),
      );
    if (owned === undefined) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Lançamento recorrente inválido' });
    }

    const [rule] = await this.db
      .insert(faturaMatchRules)
      .values({
        userId,
        cardAccountId: input.cardAccountId,
        rawNormalized,
        targetScheduleId: input.scheduleId,
      })
      .onConflictDoUpdate({
        target: [
          faturaMatchRules.userId,
          faturaMatchRules.cardAccountId,
          faturaMatchRules.rawNormalized,
        ],
        set: { targetScheduleId: input.scheduleId, updatedAt: new Date() },
      })
      .returning();
    return rule;
  }
}
