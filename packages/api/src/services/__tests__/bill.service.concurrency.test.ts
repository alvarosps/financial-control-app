/**
 * Concurrency guard on BillService.payBill.
 *
 * This test races two parallel payBill calls against the same
 * (card, month, year) triple using TWO distinct postgres-js connections so
 * the two requests run truly in parallel (not serialized under one SAVEPOINT
 * like withRollback would force).
 *
 * Expected: exactly one wins, the other rejects with CONFLICT — enforced by
 * the partial unique index `tx_bill_payment_unique` added in
 * packages/db/drizzle/0005_audit_hardening.sql.
 *
 * Manual seed + explicit DELETE teardown because we cannot use withRollback.
 */
import { accounts, createDb, userProfiles } from '@fc/db';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { runWithMaterializationLock } from '../../lib/materialization-lock.ts';
import { withRollback } from '../../test/with-rollback.ts';
import { AccountService } from '../account.service.ts';
import { BillService } from '../bill.service.ts';
import { CreditCardFlowService } from '../credit-card-flow.service.ts';
import { MaterializationGuard } from '../materialization-guard.service.ts';
import { WalletCashService } from '../wallet-cash.service.ts';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5433/financial_control_v2_test';

// Two DISTINCT connections → two separate backend processes → real parallelism.
const dbA = createDb(TEST_DB_URL);
const dbB = createDb(TEST_DB_URL);

// Separate cleanup DB handle — keeps afterEach blast-radius self-contained.
const cleanupDb = createDb(TEST_DB_URL);

const SEED_EMAIL = `concurrency-paybill-${Date.now()}@test.local`;
let seededUserId: string | null = null;

afterEach(async () => {
  // Delete the synthetic tenant atomically, including immutable purchase evidence.
  if (!seededUserId) return;
  const uid = seededUserId;
  seededUserId = null;
  await cleanupDb.delete(userProfiles).where(eq(userProfiles.id, uid));
});

describe('BillService.payBill concurrency', () => {
  it('waits for materialization before locking the wallet used by another financial operation', async () => {
    const [user] = await dbA
      .insert(userProfiles)
      .values({
        email: `paybill-lock-order-${Date.now()}@test.local`,
        name: 'Lock order',
        passwordHash: 'x',
      })
      .returning();
    seededUserId = user.id;
    const accountService = new AccountService(dbA);
    const checking = await accountService.create(user.id, {
      name: 'Wallet',
      type: 'checking',
      currency: 'BRL',
    });
    const expense = await accountService.create(user.id, {
      name: 'Expense',
      type: 'expense',
      currency: 'BRL',
    });
    const flow = new CreditCardFlowService(dbA);
    const { account: card } = await flow.createCreditCard(user.id, {
      name: 'Card',
      closingDay: 20,
      dueDay: 25,
    });
    await flow.addOneTimeExpense(user.id, {
      creditCardAccountId: card.id,
      expenseAccountId: expense.id,
      description: 'Purchase',
      amount: '100.00',
      billingMonth: 9,
      billingYear: 2026,
    });

    let payment: Promise<unknown> | undefined;
    try {
      await runWithMaterializationLock(dbB, user.id, async ({ db }) => {
        const [backend] = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        payment = new BillService(dbA, new MaterializationGuard(dbA)).payBill(
          user.id,
          card.id,
          9,
          2026,
          checking.id,
        );
        void payment.catch(() => undefined);
        await expect
          .poll(async () => {
            const [state] = await cleanupDb.execute<{ waiting: boolean }>(sql`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE ${backend.pid} = ANY(pg_blocking_pids(pid))
            ) AS waiting
          `);
            return state.waiting;
          })
          .toBe(true);
        const locked = await db.execute(sql`
          SELECT ${accounts.id} FROM ${accounts}
          WHERE ${accounts.id} = ${checking.id} FOR UPDATE NOWAIT
        `);
        expect(locked).toHaveLength(1);
      });
    } finally {
      await payment;
    }
    expect((await new WalletCashService(dbA).getWalletCash(user.id)).totalCash).toBe(-100);
  });

  it('second concurrent pay for same bill fails (sequential, after first fully pays)', async () => {
    // Sequential idempotency check — after first payBill commits, a second call
    // on the same (user, card, month, year) must be rejected. The mark-as-paid
    // loop means unpaidTotal becomes zero, so the service raises BusinessRuleError
    // ("Não há valor pendente"). If any transactions remained unpaid (e.g., a
    // race inserted new items), the DB-level unique index on tx_bill_payment_unique
    // would surface a CONFLICT instead. Both are acceptable — what matters is
    // that a second call never silently double-pays.
    await withRollback(async (db) => {
      const accSvc = new AccountService(db);
      const ccFlow = new CreditCardFlowService(db);
      const billService = new BillService(db, new MaterializationGuard(db));

      const [user] = await db
        .insert(userProfiles)
        .values({
          email: `paybill-seq-${Date.now()}@test.local`,
          name: 'seq',
          passwordHash: 'x',
        })
        .returning();

      const checking = await accSvc.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const expense = await accSvc.create(user.id, {
        name: 'Food',
        type: 'expense',
        currency: 'BRL',
      });
      const { account: card } = await ccFlow.createCreditCard(user.id, {
        name: 'Nubank',
        closingDay: 3,
        dueDay: 10,
      });
      await ccFlow.addInstallment(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'TV',
        amount: '500.00',
        totalInstallments: 1,
        currentInstallmentNumber: 1,
        currentBillingMonth: 4,
        currentBillingYear: 2026,
      });

      await billService.payBill(user.id, card.id, 4, 2026, checking.id);

      // Second attempt must be rejected — either BusinessRuleError (no unpaid
      // amount, because first call marked everything paid inside its locked
      // re-fetch) or CONFLICT (unique index on bill_payment transfers).
      const err = await billService.payBill(user.id, card.id, 4, 2026, checking.id).then(
        () => null,
        (e) => e,
      );
      expect(err).not.toBeNull();
      const message = String(err?.message ?? '');
      const code = (err as { code?: string } | null)?.code;
      expect(code === 'CONFLICT' || /valor pendente/.test(message)).toBe(true);
    });
  });

  it('exactly one of two parallel payBill calls succeeds; other gets CONFLICT', async () => {
    // === Seed via dbA ============================================
    const accSvcA = new AccountService(dbA);
    const ccFlowA = new CreditCardFlowService(dbA);

    const [user] = await dbA
      .insert(userProfiles)
      .values({ email: SEED_EMAIL, name: 'paybill-race', passwordHash: 'x' })
      .returning();
    seededUserId = user.id;

    const checking = await accSvcA.create(user.id, {
      name: 'Bank',
      type: 'checking',
      currency: 'BRL',
    });
    const expense = await accSvcA.create(user.id, {
      name: 'Food',
      type: 'expense',
      currency: 'BRL',
    });

    const { account: card } = await ccFlowA.createCreditCard(user.id, {
      name: 'Nubank',
      closingDay: 3,
      dueDay: 10,
    });

    await ccFlowA.addInstallment(user.id, {
      creditCardAccountId: card.id,
      expenseAccountId: expense.id,
      description: 'TV',
      amount: '500.00',
      totalInstallments: 1,
      currentInstallmentNumber: 1,
      currentBillingMonth: 4,
      currentBillingYear: 2026,
    });

    // Two BillService instances on distinct connections.
    const svcA = new BillService(dbA, new MaterializationGuard(dbA));
    const svcB = new BillService(dbB, new MaterializationGuard(dbB));

    // === Race =====================================================
    const [a, b] = await Promise.allSettled([
      svcA.payBill(user.id, card.id, 4, 2026, checking.id),
      svcB.payBill(user.id, card.id, 4, 2026, checking.id),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The rejected one must surface CONFLICT (mapped from the partial unique
    // index violation) OR a BusinessRuleError "no unpaid amount" if the loser
    // read after the winner's COMMIT became visible. Both are valid outcomes
    // for the correctness contract: "at most one payment per (card, month, year)".
    const reason = rejected[0].reason;
    const isConflict = reason?.code === 'CONFLICT';
    const isAlreadyPaid =
      typeof reason?.message === 'string' && /valor pendente/.test(reason.message as string);
    expect(isConflict || isAlreadyPaid).toBe(true);
    expect((await new WalletCashService(dbA).getWalletCash(user.id)).totalCash).toBe(-500);
  });
});
