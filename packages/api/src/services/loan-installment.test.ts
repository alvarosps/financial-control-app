import type { DbExecutor } from '@fc/db';
import { transactions, userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import {
  computeCurrentInstallment,
  countUnpaidInstallmentsThroughMonth,
  endOfMonth,
  isCurrentMonthInstallmentPaid,
} from './loan-installment.ts';

describe('computeCurrentInstallment', () => {
  it('returns MAX installment due on/before end of asOf month, robust to a duplicate #1', async () => {
    await withRollback(async (db: DbExecutor) => {
      const svc = new AccountService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'loan-inst@test.com', name: 'T', passwordHash: 'h' })
        .returning();
      const checking = await svc.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const loan = await svc.create(user.id, { name: 'Loan', type: 'loan', currency: 'BRL' });

      const mk = (inst: number, iso: string) => ({
        userId: user.id,
        sourceAccountId: checking.id,
        destinationAccountId: loan.id,
        amount: '100.00',
        currency: 'BRL',
        type: 'transfer' as const,
        description: `p${inst}`,
        date: new Date(iso),
        domainType: 'loan_payment' as const,
        installmentNumber: inst,
        isPaid: false,
      });
      await db.insert(transactions).values([
        mk(1, '2024-12-04'), // stray duplicate #1 (earlier)
        mk(1, '2025-01-04'), // real #1
        mk(2, '2025-02-04'),
        mk(18, '2026-06-04'),
        mk(19, '2026-07-04'), // future (after June)
      ]);

      const asOf = new Date(2026, 5, 1); // June 2026
      expect(endOfMonth(asOf).getMonth()).toBe(5); // still June
      // COUNT would be 4 (≤ June incl. the stray #1); MAX is robust → 18
      expect(await computeCurrentInstallment(db, loan.id, asOf)).toBe(18);
    });
  });

  it('returns 0 when no installment is due yet', async () => {
    await withRollback(async (db: DbExecutor) => {
      const svc = new AccountService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'loan-inst0@test.com', name: 'T', passwordHash: 'h' })
        .returning();
      const checking = await svc.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const loan = await svc.create(user.id, { name: 'Loan', type: 'loan', currency: 'BRL' });
      await db.insert(transactions).values({
        userId: user.id,
        sourceAccountId: checking.id,
        destinationAccountId: loan.id,
        amount: '100.00',
        currency: 'BRL',
        type: 'transfer',
        description: 'p1',
        date: new Date('2026-07-20'),
        domainType: 'loan_payment',
        installmentNumber: 1,
        isPaid: false,
      });
      expect(await computeCurrentInstallment(db, loan.id, new Date(2026, 5, 1))).toBe(0);
    });
  });
});

describe('isCurrentMonthInstallmentPaid', () => {
  const seed = async (db: DbExecutor, currentMonthPaid: boolean) => {
    const svc = new AccountService(db);
    const [user] = await db
      .insert(userProfiles)
      .values({ email: `lc-paid-${currentMonthPaid}@test.com`, name: 'T', passwordHash: 'h' })
      .returning();
    const checking = await svc.create(user.id, { name: 'Bank', type: 'checking', currency: 'BRL' });
    const loan = await svc.create(user.id, { name: 'Loan', type: 'loan', currency: 'BRL' });
    const mk = (inst: number, iso: string, isPaid: boolean) => ({
      userId: user.id,
      sourceAccountId: checking.id,
      destinationAccountId: loan.id,
      amount: '100.00',
      currency: 'BRL',
      type: 'transfer' as const,
      description: `p${inst}`,
      date: new Date(iso),
      domainType: 'loan_payment' as const,
      installmentNumber: inst,
      isPaid,
    });
    await db.insert(transactions).values([
      mk(1, '2026-04-04', true),
      mk(2, '2026-05-04', true),
      mk(3, '2026-06-04', currentMonthPaid), // current month (June 2026)
      mk(4, '2026-07-04', false), // future, unpaid — must be ignored
    ]);
    return loan.id;
  };

  it('returns true when no installment due on/before this month is unpaid', async () => {
    await withRollback(async (db: DbExecutor) => {
      const loanId = await seed(db, true);
      expect(await isCurrentMonthInstallmentPaid(db, loanId, new Date(2026, 5, 15))).toBe(true);
    });
  });

  it('returns false when the current month installment is unpaid', async () => {
    await withRollback(async (db: DbExecutor) => {
      const loanId = await seed(db, false);
      expect(await isCurrentMonthInstallmentPaid(db, loanId, new Date(2026, 5, 15))).toBe(false);
    });
  });
});

describe('countUnpaidInstallmentsThroughMonth', () => {
  const seedArrears = async (db: DbExecutor) => {
    const svc = new AccountService(db);
    const [user] = await db
      .insert(userProfiles)
      .values({ email: 'lc-arrears@test.com', name: 'T', passwordHash: 'h' })
      .returning();
    const checking = await svc.create(user.id, { name: 'Bank', type: 'checking', currency: 'BRL' });
    const loan = await svc.create(user.id, { name: 'Loan', type: 'loan', currency: 'BRL' });
    const mk = (inst: number, iso: string, isPaid: boolean) => ({
      userId: user.id,
      sourceAccountId: checking.id,
      destinationAccountId: loan.id,
      amount: '100.00',
      currency: 'BRL',
      type: 'transfer' as const,
      description: `p${inst}`,
      date: new Date(iso),
      domainType: 'loan_payment' as const,
      installmentNumber: inst,
      isPaid,
    });
    await db.insert(transactions).values([
      mk(1, '2026-04-04', true), // prior month, paid
      mk(2, '2026-05-04', false), // prior month, unpaid (arrears)
      mk(3, '2026-06-04', false), // current month (June 2026), unpaid
      mk(4, '2026-07-04', false), // future, unpaid — excluded by date filter
    ]);
    return loan.id;
  };

  it('counts only unpaid installments due on/before this month, excluding future ones', async () => {
    await withRollback(async (db: DbExecutor) => {
      const loanId = await seedArrears(db);
      // installments 2 and 3 are unpaid and ≤ June; 1 is paid; 4 is future → 2
      expect(await countUnpaidInstallmentsThroughMonth(db, loanId, new Date(2026, 5, 15))).toBe(2);
    });
  });
});
