import { describe, expect, it } from 'vitest';
import { getTestDb } from '../test/pool.ts';
import { withRollback } from '../test/with-rollback.ts';
import { acquireBillLock, acquireBillLocks } from './bill-lock.ts';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const CARD_ID = '22222222-2222-2222-2222-222222222222';

describe('acquireBillLock', () => {
  it('is idempotent when called twice within the same transaction', async () => {
    await withRollback(async (tx) => {
      await expect(acquireBillLock(tx, USER_ID, CARD_ID, 4, 2026)).resolves.toBeUndefined();
      await expect(acquireBillLock(tx, USER_ID, CARD_ID, 4, 2026)).resolves.toBeUndefined();
    });
  });

  it('rejects when called outside a PostgreSQL transaction', async () => {
    const db = getTestDb();
    await expect(acquireBillLock(db, USER_ID, CARD_ID, 4, 2026)).rejects.toThrow(
      /must run inside a transaction/i,
    );
  });

  it('accepts an unordered, duplicated set of bill periods in one transaction', async () => {
    await withRollback(async (tx) => {
      await expect(
        acquireBillLocks(tx, USER_ID, [
          { cardAccountId: CARD_ID, month: 5, year: 2026 },
          { cardAccountId: '33333333-3333-3333-3333-333333333333', month: 4, year: 2026 },
          { cardAccountId: CARD_ID, month: 5, year: 2026 },
        ]),
      ).resolves.toBeUndefined();
    });
  });

  it('serializes concurrent transactions on the same bill key', async () => {
    const db = getTestDb();
    // Use unique IDs for this test to avoid interference with other tests
    // running in parallel against the shared advisory-lock namespace.
    const userId = '99999999-9999-9999-9999-999999999901';
    const cardId = '99999999-9999-9999-9999-999999999902';
    const month = 7;
    const year = 2099;

    let bAcquired = false;
    let bAcquiredAt = 0;
    let aReleasedAt = 0;

    let signalAReady!: () => void;
    const aReady = new Promise<void>((resolve) => {
      signalAReady = resolve;
    });
    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const txA = db.transaction(async (tx) => {
      await acquireBillLock(tx, userId, cardId, month, year);
      signalAReady();
      await holdA;
      aReleasedAt = Date.now();
    });

    // Wait until A has actually acquired the lock — avoids racing on
    // postgres-js connection scheduling.
    await aReady;
    expect(bAcquired).toBe(false);

    const txB = db.transaction(async (tx) => {
      await acquireBillLock(tx, userId, cardId, month, year);
      bAcquired = true;
      bAcquiredAt = Date.now();
    });

    // Give B a chance to attempt the lock; it must remain blocked.
    await new Promise((r) => setTimeout(r, 100));
    expect(bAcquired).toBe(false);

    // Release A; B must now be able to acquire and complete.
    releaseA();
    await txA;
    await txB;

    expect(bAcquired).toBe(true);
    // B can only have acquired after A finished (A released the lock at COMMIT).
    expect(bAcquiredAt).toBeGreaterThanOrEqual(aReleasedAt);
  });
});
