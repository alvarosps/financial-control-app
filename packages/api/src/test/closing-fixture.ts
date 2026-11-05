import type { DbExecutor } from '@fc/db';
import { accounts } from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { MonthClosingService } from '../services/month-closing.service.ts';

/** Synthetic statements for test fixtures; never used by application flows. */
export async function reviewAndClose(
  db: DbExecutor,
  userId: string,
  month: number,
  year: number,
  notes?: string,
) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  await db
    .update(accounts)
    .set({
      openingBalance: '0.00',
      openingBalanceAnchorAt: new Date(`${start}T00:00:00-03:00`),
      cashAnchorBasis: 'effective',
    })
    .where(and(eq(accounts.userId, userId), eq(accounts.type, 'checking')));
  const service = new MonthClosingService(db);
  const first = await service.preview(userId, month, year);
  const review = {
    wallets: first.items
      .filter((i) => i.key.startsWith('wallet:'))
      .map((i) => ({
        accountId: i.key.slice(7),
        amount: i.expected ?? '0.00',
        source: 'Synthetic closing fixture',
      })),
    cards: first.items
      .filter((i) => i.key.startsWith('card:'))
      .map((i) => ({
        accountId: i.key.slice(5),
        totalAmount: i.expected ?? '0.00',
        closingDate: `${year}-${String(month).padStart(2, '0')}-20`,
        dueDate: new Date(Date.UTC(year, month, 5)).toISOString().slice(0, 10),
        source: 'Synthetic closing fixture',
      })),
  };
  const preview = await service.preview(userId, month, year, review);
  const waivers = Object.fromEntries(
    preview.items
      .filter((i) => i.severity === 'warning')
      .map((i) => [i.key, 'Reviewed synthetic exception']),
  );
  return service.closeMonth(userId, month, year, notes, {
    ...review,
    waivers,
    reviewHash: preview.reviewHash,
  });
}
