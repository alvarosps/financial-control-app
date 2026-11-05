import { monthClosings, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../test/pool.ts';
import { purchaseFixture } from '../test/purchase-fixture.ts';
import { FinancialEventService } from './financial-event.service.ts';
import { MonthClosingService } from './month-closing.service.ts';
import { PurchaseInboxService } from './purchase-inbox.service.ts';

function signal() {
  let resolve = () => {};
  let reject = (_reason?: unknown) => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('closing versus inbox application', () => {
  it.each([
    'close',
    'apply',
  ] as const)('serializes when %s obtains the lock first', async (first) => {
    const db = getTestDb();
    const f = await db.transaction(purchaseFixture);
    const held = signal();
    const release = signal();
    const attempted = signal();
    let running: Promise<unknown> | undefined;
    let competing: Promise<unknown> | undefined;
    try {
      const { observation } = await new FinancialEventService(db).ingest(f.user.id, {
        ...f.event,
        data: { ...f.event.data, purchaseDate: '2026-08-20' },
      });
      const service = new MonthClosingService(db);
      const evidence = {
        cards: [
          {
            accountId: f.card.id,
            totalAmount: '0.00',
            closingDate: '2026-08-24',
            dueDate: '2026-09-08',
            source: 'Synthetic bank statement',
          },
        ],
      };
      const preview = await service.preview(f.user.id, 8, 2026, evidence);
      const review = {
        ...evidence,
        reviewHash: preview.reviewHash,
        waivers: Object.fromEntries(
          preview.items
            .filter((i) => i.severity === 'warning')
            .map((i) => [i.key, 'Reviewed provisional evidence']),
        ),
      };
      const input = {
        observationId: observation.id,
        version: observation.version,
        expenseAccountId: f.expense.id,
        billingMonth: 8,
        billingYear: 2026,
      };
      running = db.transaction(async (tx) => {
        if (first === 'close')
          await new MonthClosingService(tx).closeMonth(
            f.user.id,
            8,
            2026,
            'Synthetic concurrency test',
            review,
          );
        else await new PurchaseInboxService(tx).accept(f.user.id, input);
        held.resolve();
        await release.promise;
      });
      void running.catch(held.reject);
      await held.promise;
      competing = db.transaction(async (tx) => {
        attempted.resolve();
        return first === 'close'
          ? new PurchaseInboxService(tx).accept(f.user.id, input)
          : new MonthClosingService(tx).closeMonth(
              f.user.id,
              8,
              2026,
              'Synthetic concurrency test',
              review,
            );
      });
      const rejected = expect(competing).rejects.toThrow(
        first === 'close' ? /closed/i : /checklist|changed/i,
      );
      await attempted.promise;
      release.resolve();
      await running;
      await rejected;
      const rows = await db.select().from(transactions).where(eq(transactions.userId, f.user.id));
      const closed = await db
        .select()
        .from(monthClosings)
        .where(eq(monthClosings.userId, f.user.id));
      expect(rows).toHaveLength(first === 'close' ? 0 : 3);
      if (first === 'close')
        expect(closed[0]).toMatchObject({ totalExpenses: '0.00', status: 'closed', revision: 1 });
      else expect(closed).toHaveLength(0);
    } finally {
      release.resolve();
      await Promise.allSettled([running, competing].filter(Boolean));
      await db.delete(userProfiles).where(eq(userProfiles.id, f.user.id));
    }
  });
});
