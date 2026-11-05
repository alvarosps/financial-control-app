import type { DbExecutor } from '@fc/db';
import { accounts, categories, transactions } from '@fc/db';
import { Money } from '@fc/domain';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { AccountService } from '../account.service.ts';
import type { CreditCardGroup, CreditCardItem } from './types.ts';

export async function getCreditCardSpending(
  db: DbExecutor,
  userId: string,
  month: number,
  year: number,
): Promise<CreditCardGroup[]> {
  // Get all active credit_card accounts for user
  const creditCardAccounts = await db
    .select({ id: accounts.id, name: accounts.name, color: accounts.color })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.type, 'credit_card'),
        eq(accounts.isActive, true),
      ),
    );

  if (creditCardAccounts.length === 0) {
    return [];
  }

  // Query transactions for the billing period:
  // - billingMonth=month, billingYear=year
  // - isReversed=false
  // - installmentNumber=1 OR installmentNumber IS NULL
  // - exclude domainType 'bill_payment' and 'credit_card_fixed_charge'
  const rows = await db
    .select({
      id: transactions.id,
      description: transactions.description,
      amount: transactions.amount,
      installmentNumber: transactions.installmentNumber,
      totalInstallments: transactions.totalInstallments,
      categoryId: transactions.categoryId,
      destinationAccountId: transactions.destinationAccountId,
      domainType: transactions.domainType,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.billingMonth, month),
        eq(transactions.billingYear, year),
        eq(transactions.isReversed, false),
        or(eq(transactions.installmentNumber, 1), isNull(transactions.installmentNumber)),
        or(
          isNull(transactions.domainType),
          and(
            ne(transactions.domainType, 'bill_payment'),
            ne(transactions.domainType, 'credit_card_fixed_charge'),
          ),
        ),
      ),
    );

  // Filter to only transactions targeting a credit card account owned by this user
  const creditCardIds = new Set(creditCardAccounts.map((cc) => cc.id));
  const childrenByParent = await new AccountService(db).getCreditCardChildrenMap(userId);
  const parentOf = new Map<string, string>();
  const childIds = new Set<string>();
  for (const [parentId, kids] of childrenByParent) {
    for (const k of kids) {
      parentOf.set(k, parentId);
      childIds.add(k);
    }
  }
  const resolveGroupId = (destId: string) => parentOf.get(destId) ?? destId;
  const filtered = rows.filter((row) => creditCardIds.has(row.destinationAccountId));

  if (filtered.length === 0) {
    return [];
  }

  // Resolve category names
  const categoryIds = [
    ...new Set(filtered.map((r) => r.categoryId).filter((id): id is string => id !== null)),
  ];
  const categoryRows =
    categoryIds.length > 0
      ? await db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(eq(categories.userId, userId))
      : [];
  const categoryMap = new Map(categoryRows.map((c) => [c.id, c.name]));

  // Group by destinationAccountId. Amounts stay as canonical money strings
  // (DB numeric(12,2) → trimmed 2dp); Money.sum handles total without drift.
  const groupMap = new Map<string, CreditCardItem[]>();
  for (const row of filtered) {
    const groupId = resolveGroupId(row.destinationAccountId);
    const items = groupMap.get(groupId) ?? [];
    items.push({
      id: row.id,
      description: row.description,
      amount: (row.domainType === 'credit_card_refund'
        ? Money.zero('BRL').subtract(Money.fromString(row.amount, 'BRL'))
        : Money.fromString(row.amount, 'BRL')
      ).toDbString(),
      domainType: row.domainType,
      direction: row.domainType === 'credit_card_refund' ? 'in' : 'out',
      installmentNumber: row.installmentNumber,
      totalInstallments: row.totalInstallments,
      categoryName: row.categoryId !== null ? (categoryMap.get(row.categoryId) ?? null) : null,
    });
    groupMap.set(groupId, items);
  }

  // Build result sorted by card name
  const result: CreditCardGroup[] = [];
  for (const cc of creditCardAccounts) {
    if (childIds.has(cc.id)) continue; // children roll into their parent
    const items = groupMap.get(cc.id);
    if (!items || items.length === 0) continue;

    const total = Money.sum(
      items.map((i) => Money.fromString(i.amount, 'BRL')),
      'BRL',
    ).toDbString();
    result.push({
      cardId: cc.id,
      cardName: cc.name,
      color: cc.color,
      total,
      items,
    });
  }

  result.sort((a, b) => a.cardName.localeCompare(b.cardName));

  return result;
}
