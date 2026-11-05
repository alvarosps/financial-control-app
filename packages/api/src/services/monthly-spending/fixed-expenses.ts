import type { DbExecutor } from '@fc/db';
import { accounts, categories, transactions } from '@fc/db';
import { getDomainTypesByGroup, Money } from '@fc/domain';
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { FixedExpenseItem } from './types.ts';

// Recurring charges materialize as `recurring_bill` transactions. Reading these
// MATERIALIZED rows (instead of predicting from schedule arithmetic) is what
// makes this breakdown reconcile, cent-for-cent, with
// MonthSummaryService.chargeExpenses — the canonical dashboard engine.
const RECURRING_DOMAIN_TYPES = getDomainTypesByGroup('recurring');

export async function getFixedExpenses(
  db: DbExecutor,
  userId: string,
  month: number,
  year: number,
): Promise<FixedExpenseItem[]> {
  const result: FixedExpenseItem[] = [];

  // --- CC fixed charges ---
  const ccChargeRows = await db
    .select({
      id: transactions.id,
      description: transactions.description,
      amount: transactions.amount,
      categoryId: transactions.categoryId,
      destinationAccountId: transactions.destinationAccountId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.domainType, 'credit_card_fixed_charge'),
        eq(transactions.billingMonth, month),
        eq(transactions.billingYear, year),
        eq(transactions.isReversed, false),
      ),
    );

  if (ccChargeRows.length > 0) {
    // Resolve card account names
    const cardAccounts = await db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.userId, userId));
    const cardMap = new Map(cardAccounts.map((a) => [a.id, a.name]));

    // Resolve categories
    const categoryIds = [
      ...new Set(ccChargeRows.map((r) => r.categoryId).filter((id): id is string => id !== null)),
    ];
    const categoryRows =
      categoryIds.length > 0
        ? await db
            .select({ id: categories.id, name: categories.name })
            .from(categories)
            .where(eq(categories.userId, userId))
        : [];
    const categoryMap = new Map(categoryRows.map((c) => [c.id, c.name]));

    for (const row of ccChargeRows) {
      result.push({
        id: row.id,
        description: row.description,
        amount: Money.fromString(row.amount, 'BRL').toDbString(),
        source: cardMap.get(row.destinationAccountId) ?? 'Unknown',
        categoryName: row.categoryId !== null ? (categoryMap.get(row.categoryId) ?? null) : null,
        fixedCategory: 'assinatura',
      });
    }
  }

  // --- Recurring charges (materialized `recurring_bill` occurrences) ---
  //
  // Read the MATERIALIZED rows by transaction DATE within the month window —
  // exactly like MonthSummaryService.chargeExpenses — instead of predicting
  // occurrences from schedule `startDate` arithmetic. The previous version
  // listed an item for every month from the schedule start onward (regardless
  // of whether the materializer actually produced a row), so a month past the
  // materialization horizon, or whose first occurrence landed in a different
  // month, showed a phantom item the dashboard never counted. Reading the real
  // rows makes the breakdown total equal the dashboard's chargeExpenses.
  //
  // UTC-constructed boundaries match the (UTC-aligned) MonthSummaryService date
  // window so the two reconcile exactly: the `date` column is UTC-midnight, so
  // local construction would shift month edges by a day in UTC−3.
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 0));

  const recurringRows = await db
    .select({
      id: transactions.id,
      description: transactions.description,
      amount: transactions.amount,
      date: transactions.date,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(transactions.domainType, RECURRING_DOMAIN_TYPES),
        eq(transactions.isReversed, false),
        isNull(transactions.reversesTransactionId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
      ),
    );

  if (recurringRows.length > 0) {
    // Resolve categories for recurring rows
    const recurringCategoryIds = [
      ...new Set(recurringRows.map((r) => r.categoryId).filter((id): id is string => id !== null)),
    ];
    const recurringCategoryRows =
      recurringCategoryIds.length > 0
        ? await db
            .select({ id: categories.id, name: categories.name })
            .from(categories)
            .where(eq(categories.userId, userId))
        : [];
    const recurringCategoryMap = new Map(recurringCategoryRows.map((c) => [c.id, c.name]));

    for (const row of recurringRows) {
      result.push({
        id: row.id,
        description: row.description,
        amount: Money.fromString(row.amount, 'BRL').toDbString(),
        source: 'Recorrente',
        categoryName:
          row.categoryId !== null ? (recurringCategoryMap.get(row.categoryId) ?? null) : null,
        fixedCategory: 'conta',
      });
    }
  }

  return result;
}
