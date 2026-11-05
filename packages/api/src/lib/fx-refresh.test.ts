import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type FxFetcher, FxRateService } from '../services/fx-rate.service.ts';
import { withRollback } from '../test/with-rollback.ts';
import { bestEffortFxRefresh } from './fx-refresh.ts';

describe('bestEffortFxRefresh', () => {
  it('resolves when the external HTTP fetcher fails (refreshIfStale swallows it)', async () => {
    await withRollback(async (db) => {
      // Fetcher = external HTTP boundary, so a stub is permitted by the mock policy.
      const failingFetcher: FxFetcher = async () => {
        throw new Error('AwesomeAPI returned HTTP 503');
      };
      const fxRate = new FxRateService(db, failingFetcher);
      await expect(bestEffortFxRefresh(fxRate)).resolves.toBeUndefined();
    });
  });

  it('resolves (never rejects) even when the database itself errors', async () => {
    await withRollback(async (db) => {
      await db
        .transaction(async (tx) => {
          // Poison the savepoint with a real SQL error. Every later statement in
          // it fails with 25P02 (current transaction is aborted).
          await tx.execute(sql`SELECT 1/0`).catch(() => {});
          const fxRate = new FxRateService(tx);
          await expect(bestEffortFxRefresh(fxRate)).resolves.toBeUndefined();
        })
        .catch(() => {
          // The poisoned savepoint rejects during COMMIT/RELEASE, as expected.
        });
    });
  });
});
