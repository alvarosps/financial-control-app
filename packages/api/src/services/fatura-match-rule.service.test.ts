import type { DbExecutor } from '@fc/db';
import { accounts, scheduledTransactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { FaturaMatchRuleService } from './fatura-match-rule.service.ts';

async function seedRuleFixture(db: DbExecutor, suffix: string) {
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `fatura-rule-${suffix}-${Math.random().toString(36).slice(2)}@example.com`,
      name: `Fatura Rule ${suffix}`,
    })
    .returning();
  const [expenseAccount, cardAccount] = await db
    .insert(accounts)
    .values([
      { userId: user.id, name: `Expense ${suffix}`, type: 'checking', currency: 'BRL' },
      { userId: user.id, name: `Card ${suffix}`, type: 'credit_card', currency: 'BRL' },
    ])
    .returning();
  const [schedule] = await db
    .insert(scheduledTransactions)
    .values({
      userId: user.id,
      sourceAccountId: expenseAccount.id,
      destinationAccountId: cardAccount.id,
      amount: '1162.79',
      currency: 'BRL',
      description: 'claude max',
      frequency: 'monthly',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      dueDay: 10,
      domainType: 'credit_card_fixed_charge',
      isFixedCharge: true,
    })
    .returning();
  return { user, cardAccount, schedule };
}

describe('FaturaMatchRuleService', () => {
  it('learns a normalized rule scoped to the user and card', async () => {
    await withRollback(async (db) => {
      const owner = await seedRuleFixture(db, 'owner');
      const other = await seedRuleFixture(db, 'other');
      const service = new FaturaMatchRuleService(db);

      await service.learn(owner.user.id, {
        cardAccountId: owner.cardAccount.id,
        rawDescription: '  ANTHROPIC* CLAUDE SUB ',
        scheduleId: owner.schedule.id,
      });

      await expect(service.listForCards(owner.user.id, [owner.cardAccount.id])).resolves.toEqual([
        {
          cardAccountId: owner.cardAccount.id,
          rawNormalized: 'anthropic claude sub',
          scheduleId: owner.schedule.id,
        },
      ]);
      await expect(service.listForCards(other.user.id, [owner.cardAccount.id])).resolves.toEqual(
        [],
      );
    });
  });

  it('updates the target schedule when the same raw description is relearned', async () => {
    await withRollback(async (db) => {
      const fixture = await seedRuleFixture(db, 'update');
      const [replacement] = await db
        .insert(scheduledTransactions)
        .values({
          userId: fixture.user.id,
          sourceAccountId: fixture.schedule.sourceAccountId,
          destinationAccountId: fixture.cardAccount.id,
          amount: '1183.35',
          currency: 'BRL',
          description: 'claude max replacement',
          frequency: 'monthly',
          startDate: new Date('2026-02-01T00:00:00.000Z'),
          dueDay: 10,
          domainType: 'credit_card_fixed_charge',
          isFixedCharge: true,
        })
        .returning();
      const service = new FaturaMatchRuleService(db);

      await service.learn(fixture.user.id, {
        cardAccountId: fixture.cardAccount.id,
        rawDescription: 'ANTHROPIC* CLAUDE SUB',
        scheduleId: fixture.schedule.id,
      });
      await service.learn(fixture.user.id, {
        cardAccountId: fixture.cardAccount.id,
        rawDescription: 'ANTHROPIC* CLAUDE SUB',
        scheduleId: replacement.id,
      });

      const rules = await service.listForCards(fixture.user.id, [fixture.cardAccount.id]);
      expect(rules).toHaveLength(1);
      expect(rules[0]?.scheduleId).toBe(replacement.id);
    });
  });

  it('learns and lists an alias for a scheduled refund', async () => {
    await withRollback(async (db) => {
      const fixture = await seedRuleFixture(db, 'refund');
      await db
        .update(scheduledTransactions)
        .set({ domainType: 'credit_card_refund', isFixedCharge: false })
        .where(eq(scheduledTransactions.id, fixture.schedule.id));
      const service = new FaturaMatchRuleService(db);

      await service.learn(fixture.user.id, {
        cardAccountId: fixture.cardAccount.id,
        rawDescription: 'ESTORNO DE ANUIDADE DIF',
        scheduleId: fixture.schedule.id,
      });

      await expect(
        service.listForCards(fixture.user.id, [fixture.cardAccount.id]),
      ).resolves.toEqual([
        {
          cardAccountId: fixture.cardAccount.id,
          rawNormalized: 'estorno de anuidade dif',
          scheduleId: fixture.schedule.id,
        },
      ]);
    });
  });
});
