import type { DbExecutor } from '@fc/db';
import { monthClosings } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, eq, or } from 'drizzle-orm';
import { errorCause } from '../lib/error-codes.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';

export class FinancialPeriodGuard {
  constructor(private db: DbExecutor) {}
  async assertOpen(userId: string, dates: string[]) {
    const periods = [...new Set(dates.map((date) => date.slice(0, 7)))];
    if (!periods.length) return;
    if (periods.some((period) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)))
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid financial period' });
    return runWithMaterializationLock(this.db, userId, async ({ db }) => {
      const [closed] = await db
        .select({ id: monthClosings.id })
        .from(monthClosings)
        .where(
          and(
            eq(monthClosings.userId, userId),
            eq(monthClosings.status, 'closed'),
            or(
              ...periods.map((period) =>
                and(
                  eq(monthClosings.year, Number(period.slice(0, 4))),
                  eq(monthClosings.month, Number(period.slice(5, 7))),
                ),
              ),
            ),
          ),
        )
        .limit(1);
      if (closed)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Financial period is closed; reopen it with a reason before changing it',
          cause: errorCause('financial.periodClosed'),
        });
    });
  }
}
