export type CategoryOption = { id: string; name: string };

export function orderCategoriesByUsage(
  categories: CategoryOption[],
  transactions: { categoryId: string | null }[],
): CategoryOption[] {
  const usage = new Map<string, number>();
  for (const transaction of transactions) {
    if (transaction.categoryId) {
      usage.set(transaction.categoryId, (usage.get(transaction.categoryId) ?? 0) + 1);
    }
  }

  return [...categories].sort((left, right) => {
    const difference = (usage.get(right.id) ?? 0) - (usage.get(left.id) ?? 0);
    return difference === 0 ? left.name.localeCompare(right.name) : difference;
  });
}
