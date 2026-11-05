import type { DbExecutor } from '@fc/db';
import { accounts, creditCardConfigs } from '@fc/db';
import { InvariantViolationError } from '@fc/domain';
import { and, eq, inArray } from 'drizzle-orm';

export type EffectiveCardConfig = {
  accountId: string;
  configOwnerAccountId: string;
  closingDay: number;
  dueDay: number;
};

type CardRow = {
  id: string;
  userId: string;
  type: string;
  parentAccountId: string | null;
};

export async function resolveCardGroupOwners(
  db: DbExecutor,
  userId: string,
  accountIds: string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length === 0) return new Map();

  const selected = await db
    .select({
      id: accounts.id,
      userId: accounts.userId,
      type: accounts.type,
      parentAccountId: accounts.parentAccountId,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), inArray(accounts.id, uniqueIds)));

  if (selected.length !== uniqueIds.length) {
    throw new InvariantViolationError('Card account is missing or outside the current user', {
      requested: uniqueIds.length,
      found: selected.length,
    });
  }

  const parentIds = selected
    .map((card) => card.parentAccountId)
    .filter((id): id is string => id !== null);
  const parents =
    parentIds.length === 0
      ? []
      : await db
          .select({
            id: accounts.id,
            userId: accounts.userId,
            type: accounts.type,
            parentAccountId: accounts.parentAccountId,
          })
          .from(accounts)
          .where(and(eq(accounts.userId, userId), inArray(accounts.id, parentIds)));
  const byId = new Map<string, CardRow>(
    [...selected, ...parents].map((account) => [account.id, account]),
  );
  const owners = new Map<string, string>();

  for (const card of selected) {
    if (card.type !== 'credit_card') {
      throw new InvariantViolationError('Expected a credit-card account', { accountId: card.id });
    }
    if (card.parentAccountId === null) {
      owners.set(card.id, card.id);
      continue;
    }
    const parent = byId.get(card.parentAccountId);
    if (
      parent === undefined ||
      parent.userId !== userId ||
      parent.type !== 'credit_card' ||
      parent.parentAccountId !== null
    ) {
      throw new InvariantViolationError('Invalid additional-card hierarchy', {
        accountId: card.id,
      });
    }
    owners.set(card.id, parent.id);
  }

  return owners;
}

export async function loadEffectiveCardConfigs(
  db: DbExecutor,
  userId: string,
  cardAccountIds: string[],
): Promise<Map<string, EffectiveCardConfig>> {
  const owners = await resolveCardGroupOwners(db, userId, cardAccountIds);
  const ownerIds = [...new Set(owners.values())];
  if (ownerIds.length === 0) return new Map();

  const configs = await db
    .select({
      accountId: creditCardConfigs.accountId,
      closingDay: creditCardConfigs.closingDay,
      dueDay: creditCardConfigs.dueDay,
    })
    .from(creditCardConfigs)
    .where(inArray(creditCardConfigs.accountId, ownerIds));
  const configByOwner = new Map(configs.map((config) => [config.accountId, config]));
  const result = new Map<string, EffectiveCardConfig>();

  for (const [accountId, ownerId] of owners) {
    const config = configByOwner.get(ownerId);
    if (config === undefined) {
      continue;
    }
    result.set(accountId, {
      accountId,
      configOwnerAccountId: ownerId,
      closingDay: config.closingDay,
      dueDay: config.dueDay,
    });
  }

  return result;
}
