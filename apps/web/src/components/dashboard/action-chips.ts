import { isWithinDays } from '@/lib/dates';

/** Structural subset of dashboard.upcomingItems rows needed by the action strip. */
export type UpcomingLike = {
  kind: 'card' | 'loan' | 'fixed_charge' | 'one_time_charge';
  isPaid: boolean;
  dueDate: string;
};

export type ActionChip = {
  id: 'cardsDue' | 'billsDue' | 'incomeCredited';
  count: number;
};

const WINDOW_DAYS = 7;

/** Pure action-strip derivation so it can be tested independently of tRPC. */
export function buildActionChips(
  items: UpcomingLike[],
  creditedToday: number,
  now: Date = new Date(),
): ActionChip[] {
  const dueSoon = items.filter(
    (item) => !item.isPaid && isWithinDays(item.dueDate, WINDOW_DAYS, now),
  );
  const cards = dueSoon.filter((item) => item.kind === 'card').length;
  const bills = dueSoon.length - cards;

  const chips: ActionChip[] = [];
  if (cards > 0) chips.push({ id: 'cardsDue', count: cards });
  if (bills > 0) chips.push({ id: 'billsDue', count: bills });
  if (creditedToday > 0) chips.push({ id: 'incomeCredited', count: creditedToday });
  return chips;
}
