import type { DbExecutor } from '@fc/db';
import { accounts, creditCardBills, transactions } from '@fc/db';
import { resolveStatementCycle, type StatementCycle } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, or } from 'drizzle-orm';
import { acquireBillLocks } from '../lib/bill-lock.ts';
import { loadEffectiveCardConfigs, resolveCardGroupOwners } from '../lib/card-group.ts';
import { computeCardBillTotals } from '../lib/credit-card-totals.ts';

export type StatementRef = { cardAccountId: string; month: number; year: number };
export const statementKey = (ref: StatementRef) => `${ref.cardAccountId}:${ref.year}-${ref.month}`;
const confirmed = (source: string) => source === 'institution' || source === 'user';

export class StatementCycleService {
  constructor(private readonly db: DbExecutor) {}

  async resolveMany(userId: string, refs: StatementRef[]) {
    const ids = [...new Set(refs.map((ref) => ref.cardAccountId))];
    if (ids.length === 0) return new Map<string, StatementCycle & { billId: string | null }>();
    const owners = await resolveCardGroupOwners(this.db, userId, ids);
    const configs = await loadEffectiveCardConfigs(this.db, userId, ids);
    const bills = await this.db
      .select()
      .from(creditCardBills)
      .where(
        and(
          inArray(creditCardBills.creditCardAccountId, [...new Set([...ids, ...owners.values()])]),
          or(
            ...refs.map((ref) =>
              and(eq(creditCardBills.month, ref.month), eq(creditCardBills.year, ref.year)),
            ),
          ),
        ),
      );
    const indexed = new Map(
      bills.map((bill) => [
        statementKey({
          cardAccountId: bill.creditCardAccountId,
          month: bill.month,
          year: bill.year,
        }),
        bill,
      ]),
    );
    return new Map(
      refs.map((ref) => {
        const own = indexed.get(statementKey(ref));
        const parent = indexed.get(
          statementKey({
            ...ref,
            cardAccountId: owners.get(ref.cardAccountId) ?? ref.cardAccountId,
          }),
        );
        const closing = parent && confirmed(parent.closingDateSource) ? parent : own;
        const due = parent && confirmed(parent.dueDateSource) ? parent : own;
        const config = configs.get(ref.cardAccountId);
        const cycle = resolveStatementCycle({
          reference: 'closing',
          month: ref.month,
          year: ref.year,
          config,
          closingDate: closing && confirmed(closing.closingDateSource) ? closing.closingDate : null,
          dueDate: due && confirmed(due.dueDateSource) ? due.dueDate : null,
          closingDateSource: closing?.closingDateSource === 'user' ? 'user' : 'institution',
          dueDateSource: due?.dueDateSource === 'user' ? 'user' : 'institution',
        });
        return [statementKey(ref), { ...cycle, billId: parent?.id ?? own?.id ?? null }];
      }),
    );
  }

  async persist(userId: string, ref: StatementRef, cycle: StatementCycle) {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.id, ref.cardAccountId),
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
        ),
      );
    if (!account)
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'statement.cardNotFound',
        cause: { i18nKey: 'statement.cardNotFound' },
      });
    const owners = await resolveCardGroupOwners(this.db, userId, [ref.cardAccountId]);
    const owner = owners.get(ref.cardAccountId) ?? ref.cardAccountId;
    const ids = [...new Set([ref.cardAccountId, owner])];
    await acquireBillLocks(
      this.db,
      userId,
      ids.map((cardAccountId) => ({ ...ref, cardAccountId })),
    );
    const peers = await this.db
      .select()
      .from(creditCardBills)
      .where(
        and(
          inArray(creditCardBills.creditCardAccountId, ids),
          eq(creditCardBills.month, ref.month),
          eq(creditCardBills.year, ref.year),
        ),
      )
      .for('update');
    const existing = peers.find((bill) => bill.creditCardAccountId === ref.cardAccountId);
    for (const key of ['closingDate', 'dueDate'] as const) {
      const sourceKey = `${key}Source` as const;
      if (
        confirmed(cycle[sourceKey]) &&
        peers.some((bill) => confirmed(bill[sourceKey]) && cycle[key] && bill[key] !== cycle[key])
      )
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'statement.cycleConflict',
          cause: { i18nKey: 'statement.cycleConflict' },
        });
    }
    // An additional shares its parent's statement calendar, including future readers.
    if (owner !== ref.cardAccountId)
      await this.persist(userId, { ...ref, cardAccountId: owner }, cycle);
    const items = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.destinationAccountId, ref.cardAccountId),
          eq(transactions.billingMonth, ref.month),
          eq(transactions.billingYear, ref.year),
          eq(transactions.isReversed, false),
        ),
      );
    const totals = computeCardBillTotals(
      items.filter((item) => item.domainType !== 'bill_payment'),
      account.currency,
    );
    const dates = {
      closingDate:
        existing && confirmed(existing.closingDateSource)
          ? existing.closingDate
          : cycle.closingDate,
      dueDate: existing && confirmed(existing.dueDateSource) ? existing.dueDate : cycle.dueDate,
      closingDateSource:
        existing && confirmed(existing.closingDateSource)
          ? existing.closingDateSource
          : cycle.closingDateSource,
      dueDateSource:
        existing && confirmed(existing.dueDateSource)
          ? existing.dueDateSource
          : cycle.dueDateSource,
    };
    await this.db
      .insert(creditCardBills)
      .values({
        creditCardAccountId: ref.cardAccountId,
        month: ref.month,
        year: ref.year,
        totalAmount: totals.totalMoney.toDbString(),
        ...dates,
      })
      .onConflictDoUpdate({
        target: [creditCardBills.creditCardAccountId, creditCardBills.month, creditCardBills.year],
        set: { ...dates, updatedAt: new Date() },
      });
  }
}
