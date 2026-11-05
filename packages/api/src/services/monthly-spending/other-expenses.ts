import type { DbExecutor } from '@fc/db';
import { accounts, categories, transactions } from '@fc/db';
import { Money } from '@fc/domain';
import { and, eq, gte, lte, ne } from 'drizzle-orm';
import { EXCLUDED_OTHER_DOMAIN_TYPES, type OtherExpenseItem } from './types.ts';

export async function getOtherExpenses(
  db: DbExecutor,
  userId: string,
  month: number,
  year: number,
): Promise<OtherExpenseItem[]> {
  // Get credit card account IDs to exclude transactions destined to them
  const creditCardAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.type, 'credit_card')));
  const creditCardIds = new Set(creditCardAccounts.map((a) => a.id));

  // Date range for the requested month
  const dateFrom = new Date(year, month - 1, 1);
  const dateTo = new Date(year, month, 0); // last day of month

  const rows = await db
    .select({
      id: transactions.id,
      description: transactions.description,
      amount: transactions.amount,
      date: transactions.date,
      type: transactions.type,
      domainType: transactions.domainType,
      categoryId: transactions.categoryId,
      destinationAccountId: transactions.destinationAccountId,
      sourceAccountId: transactions.sourceAccountId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, dateFrom),
        lte(transactions.date, dateTo),
        eq(transactions.isReversed, false),
        ne(transactions.type, 'deposit'),
      ),
    );

  // Filter out excluded domain types and credit card destinations
  const filtered = rows.filter((row) => {
    if (row.domainType !== null && EXCLUDED_OTHER_DOMAIN_TYPES.has(row.domainType)) return false;
    if (creditCardIds.has(row.destinationAccountId)) return false;
    return true;
  });

  if (filtered.length === 0) return [];

  // Resolve source account names
  const sourceAccounts = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const sourceAccountMap = new Map(sourceAccounts.map((a) => [a.id, a.name]));

  // Resolve categories
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

  // Sort chronologically
  filtered.sort((a, b) => {
    const dateA = a.date instanceof Date ? a.date : new Date(a.date);
    const dateB = b.date instanceof Date ? b.date : new Date(b.date);
    return dateA.getTime() - dateB.getTime();
  });

  return filtered.map((row) => ({
    id: row.id,
    description: row.description,
    amount: Money.fromString(row.amount, 'BRL').toDbString(),
    date: (row.date instanceof Date ? row.date : new Date(row.date)).toISOString().split('T')[0],
    categoryName: row.categoryId !== null ? (categoryMap.get(row.categoryId) ?? null) : null,
    sourceAccountName: sourceAccountMap.get(row.sourceAccountId) ?? 'Unknown',
  }));
}
