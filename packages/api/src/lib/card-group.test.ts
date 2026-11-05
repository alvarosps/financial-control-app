import { accounts, creditCardConfigs, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { loadEffectiveCardConfigs } from './card-group.ts';

describe('loadEffectiveCardConfigs', () => {
  it('maps an additional card to its principal configuration', async () => {
    await withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'card-group@example.com', name: 'Card Group', passwordHash: 'hash' })
        .returning();
      const [principal] = await db
        .insert(accounts)
        .values({ userId: user.id, name: 'Principal', type: 'credit_card' })
        .returning();
      const [additional] = await db
        .insert(accounts)
        .values({
          userId: user.id,
          name: 'Additional',
          type: 'credit_card',
          parentAccountId: principal.id,
        })
        .returning();
      await db
        .insert(creditCardConfigs)
        .values({ accountId: principal.id, closingDay: 17, dueDay: 24 });

      const configs = await loadEffectiveCardConfigs(db, user.id, [additional.id]);

      expect(configs.get(additional.id)).toMatchObject({
        accountId: additional.id,
        configOwnerAccountId: principal.id,
        closingDay: 17,
        dueDay: 24,
      });
    });
  });
});
