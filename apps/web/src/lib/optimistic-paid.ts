type PaidItem = { isPaid: boolean };

export function setPaidFor<T extends PaidItem>(
  items: T[] | undefined,
  matches: (item: T) => boolean,
  isPaid: boolean,
): T[] | undefined {
  return items?.map((item) => (matches(item) ? { ...item, isPaid } : item));
}

export function rollbackPaidFor<T extends PaidItem>(
  items: T[] | undefined,
  keyOf: (item: T) => string,
  targetKey: string,
  previousIsPaid: boolean,
  optimisticIsPaid: boolean,
): T[] | undefined {
  return items?.map((item) =>
    keyOf(item) === targetKey && item.isPaid === optimisticIsPaid
      ? { ...item, isPaid: previousIsPaid }
      : item,
  );
}
