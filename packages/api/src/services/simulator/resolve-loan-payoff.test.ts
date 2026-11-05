import type { DbExecutor } from '@fc/db';
import { transactions, userProfiles } from '@fc/db';
import { calculateOutstandingBalance, Money } from '@fc/domain';
import type { MonthRef, SimLever } from '@fc/shared';
import Decimal from 'decimal.js';
import { and, eq, gt } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../../test/with-rollback.ts';
import { AccountService } from '../account.service.ts';
import { LoanFlowService } from '../loan-flow.service.ts';
import { resolveLoanPayoff } from './resolve-loan-payoff.ts';

function horizonMonths(start: MonthRef, n: number): MonthRef[] {
  const out: MonthRef[] = [];
  for (let i = 0; i < n; i++) {
    const m0 = start.month - 1 + i;
    out.push({ month: (((m0 % 12) + 12) % 12) + 1, year: start.year + Math.floor(m0 / 12) });
  }
  return out;
}

describe('resolveLoanPayoff', () => {
  it('uses only a quote valid at the target month and covers installments beyond materialized rows', async () => {
    await withRollback(async (db) => {
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'cost-payoff@test.com', name: 'P', passwordHash: 'h' })
        .returning();
      const wallet = await new AccountService(db).create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const flow = new LoanFlowService(db);
      const { account } = await flow.createLoan(user.id, {
        name: 'Debt',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '100.00',
        totalInstallments: 48,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 5, 10),
        checkingAccountId: wallet.id,
        monthlyInterestRate: '0.00000000',
      });
      await flow.updateCostEvidence(user.id, account.id, {
        payoffQuote: {
          amount: '4200.00',
          quotedOn: '2026-05-20',
          validUntil: '2026-06-10',
          source: 'Bank',
        },
        economicResponsibility: 'family',
      });
      // Rebuilding a schedule can leave only the projection horizon materialized.
      await db
        .delete(transactions)
        .where(and(eq(transactions.userId, user.id), gt(transactions.installmentNumber, 12)));
      const months = horizonMonths({ month: 6, year: 2026 }, 6);
      const ctx = { months, horizon: 6, asOf: new Date(2026, 4, 25) };
      const lever: SimLever = {
        kind: 'loan_payoff',
        id: 'quote',
        loanAccountId: account.id,
        targetMonth: { month: 6, year: 2026 },
      };
      const valid = await resolveLoanPayoff(db, user.id, lever, ctx);
      expect(valid.events[0]).toMatchObject({ amount: '4200.00' });
      expect(valid.events[0].label).toMatch(/quote.*family/i);
      const expired = await resolveLoanPayoff(
        db,
        user.id,
        { ...lever, targetMonth: { month: 7, year: 2026 } },
        ctx,
      );
      expect(expired.events[0]).toMatchObject({ amount: '4700.00' });
      expect(expired.events[0].label).toMatch(/expired/i);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, user.id)),
      ).toHaveLength(12);
    });
  });
  it('removes only the real remaining installments and stops at the loan end', async () => {
    await withRollback(async (db: DbExecutor) => {
      const accountService = new AccountService(db);
      const loanFlowService = new LoanFlowService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'payoff@test.com', name: 'P', passwordHash: 'h' })
        .returning();
      const checking = await accountService.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });

      // 3 remaining installments: occurrences 1,2,3 due Jun/Jul/Aug 2026.
      const { account } = await loanFlowService.createLoan(user.id, {
        name: 'CDC',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '1000.00',
        totalInstallments: 3,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 5, 10), // Jun 2026
        checkingAccountId: checking.id,
        monthlyInterestRate: '0.02000000',
        payoffCalculationType: 'sem_desconto',
      });

      const start: MonthRef = { month: 6, year: 2026 };
      const months = horizonMonths(start, 6); // Jun..Nov 2026
      const lever: SimLever = {
        kind: 'loan_payoff',
        id: 'lp',
        loanAccountId: account.id,
        targetMonth: { month: 6, year: 2026 },
        // no partialAmount → full payoff via payoff.ts
      };

      // asOf is May 2026 so the June targetMonth is a FUTURE month and the
      // current-month payoff guard does not fire (it would zero the delta).
      const delta = await resolveLoanPayoff(db, user.id, lever, {
        months,
        horizon: 6,
        asOf: new Date(2026, 4, 1),
      });

      // 6 months present, in order.
      expect(delta.byMonth).toHaveLength(6);
      // Jul/Aug each remove one 1000 installment as a NEGATIVE expense delta.
      // (Jun also removes one installment but the lump sum lands there too — its
      // combined value is asserted at the end of this test.)
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      expect(byKey.get('2026-7')?.expenseDelta).toBe('-1000.00');
      expect(byKey.get('2026-8')?.expenseDelta).toBe('-1000.00');
      // Sep onward: the loan has ENDED — no flat-forever subtraction.
      expect(byKey.get('2026-9')?.expenseDelta).toBe('0.00');
      expect(byKey.get('2026-10')?.expenseDelta).toBe('0.00');
      expect(byKey.get('2026-11')?.expenseDelta).toBe('0.00');

      // Lump sum hits targetMonth (Jun) as an outflow event; sem_desconto = 3 * 1000.
      expect(delta.events).toHaveLength(1);
      expect(delta.events[0]).toMatchObject({
        month: 6,
        year: 2026,
        sign: 'outflow',
        amount: '3000.00',
      });
      // The lump sum also lands in the Jun expense bucket on top of the removed installment.
      // Jun expenseDelta = -1000 (installment removed) + 3000 (lump sum) = 2000.00
      expect(byKey.get('2026-6')?.expenseDelta).toBe('2000.00');
    });
  });

  it('uses partialAmount as the lump sum when provided', async () => {
    await withRollback(async (db: DbExecutor) => {
      const accountService = new AccountService(db);
      const loanFlowService = new LoanFlowService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'payoff2@test.com', name: 'P', passwordHash: 'h' })
        .returning();
      const checking = await accountService.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const { account } = await loanFlowService.createLoan(user.id, {
        name: 'CDC',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '500.00',
        totalInstallments: 4,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 5, 10),
        checkingAccountId: checking.id,
        monthlyInterestRate: '0.02000000',
      });

      const months = horizonMonths({ month: 6, year: 2026 }, 6);
      const lever: SimLever = {
        kind: 'loan_payoff',
        id: 'lp',
        loanAccountId: account.id,
        targetMonth: { month: 7, year: 2026 },
        partialAmount: '1234.56',
      };

      const delta = await resolveLoanPayoff(db, user.id, lever, {
        months,
        horizon: 6,
        asOf: new Date(2026, 5, 1),
      });

      expect(delta.events).toHaveLength(1);
      expect(delta.events[0]).toMatchObject({
        month: 7,
        year: 2026,
        sign: 'outflow',
        amount: '1234.56',
      });
    });
  });

  it('discounts the lump sum to present value for a PV payoff type with a positive rate', async () => {
    await withRollback(async (db: DbExecutor) => {
      const accountService = new AccountService(db);
      const loanFlowService = new LoanFlowService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'payoff-pv@test.com', name: 'P', passwordHash: 'h' })
        .returning();
      const checking = await accountService.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });

      // 3 remaining installments: occurrences 1,2,3 due Jun/Jul/Aug 2026.
      // cdc_veiculos discounts each remaining payment back to present value at
      // the monthly rate, so the lump sum is LESS than the plain pay * n.
      const { account } = await loanFlowService.createLoan(user.id, {
        name: 'CDC Veiculo',
        loanCategory: 'bank',
        loanType: 'veiculo',
        monthlyPayment: '1000.00',
        totalInstallments: 3,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 5, 10), // Jun 2026
        checkingAccountId: checking.id,
        monthlyInterestRate: '0.02000000',
        payoffCalculationType: 'cdc_veiculos',
      });

      const months = horizonMonths({ month: 6, year: 2026 }, 6); // Jun..Nov 2026
      const lever: SimLever = {
        kind: 'loan_payoff',
        id: 'lp',
        loanAccountId: account.id,
        targetMonth: { month: 6, year: 2026 },
        // no partialAmount → full payoff via calculateOutstandingBalance
      };

      // asOf is May 2026 so the June targetMonth is a FUTURE month (the
      // current-month guard does not fire).
      const delta = await resolveLoanPayoff(db, user.id, lever, {
        months,
        horizon: 6,
        asOf: new Date(2026, 4, 1),
      });

      // The discounted present value the domain computes for these exact inputs.
      const expectedLump = calculateOutstandingBalance({
        type: 'cdc_veiculos',
        monthlyPayment: Money.fromString('1000.00', 'BRL'),
        remainingInstallments: 3,
        monthlyInterestRate: Money.fromDecimal(new Decimal('0.02000000'), 'BRL'),
      });

      // The DISCOUNTED branch: lump < monthlyPayment * remaining (3 * 1000 = 3000).
      const plainTotal = Money.fromString('1000.00', 'BRL').multiply(3);
      expect(expectedLump.isLessThan(plainTotal)).toBe(true);

      // Lump sum lands in Jun as an outflow event, at the discounted PV value.
      expect(delta.events).toHaveLength(1);
      expect(delta.events[0]).toMatchObject({
        month: 6,
        year: 2026,
        sign: 'outflow',
        amount: expectedLump.toDbString(),
      });
      // Jun expense bucket = -1000 (installment removed) + discounted lump.
      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      const junExpected = expectedLump.subtract(Money.fromString('1000.00', 'BRL'));
      expect(byKey.get('2026-6')?.expenseDelta).toBe(junExpected.toDbString());
    });
  });

  it('never reads or echoes another user loan when given a foreign loanAccountId (IDOR)', async () => {
    await withRollback(async (db: DbExecutor) => {
      const accountService = new AccountService(db);
      const loanFlowService = new LoanFlowService(db);

      // User A owns a configured loan with a distinctive comment. If the resolver
      // ever leaks A's config, the comment surfaces as an event label and the
      // partialAmount lump sum lands as an outflow — both are asserted absent.
      const [userA] = await db
        .insert(userProfiles)
        .values({ email: 'idor-a@test.com', name: 'A', passwordHash: 'h' })
        .returning();
      const aChecking = await accountService.create(userA.id, {
        name: 'Bank A',
        type: 'checking',
        currency: 'BRL',
      });
      const { account: aLoan } = await loanFlowService.createLoan(userA.id, {
        name: 'A secret CDC',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '1000.00',
        totalInstallments: 3,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 5, 10),
        checkingAccountId: aChecking.id,
        monthlyInterestRate: '0.02000000',
        payoffCalculationType: 'sem_desconto',
        comment: 'A-SECRET-LOAN-COMMENT',
      });

      // User B attacks with A's loanAccountId. partialAmount makes the lump sum
      // independent of any owned installments, so if the config read were
      // unscoped, B would get a non-empty delta carrying A's comment.
      const [userB] = await db
        .insert(userProfiles)
        .values({ email: 'idor-b@test.com', name: 'B', passwordHash: 'h' })
        .returning();

      const months = horizonMonths({ month: 6, year: 2026 }, 6); // Jun..Nov 2026
      const lever: SimLever = {
        kind: 'loan_payoff',
        id: 'lp',
        loanAccountId: aLoan.id,
        targetMonth: { month: 6, year: 2026 },
        partialAmount: '1234.56',
      };

      // asOf is May 2026 so the June targetMonth is FUTURE — the resolver reaches
      // the (tenant-scoped) config read this test exercises, instead of being
      // short-circuited by the current-month guard.
      const delta = await resolveLoanPayoff(db, userB.id, lever, {
        months,
        horizon: 6,
        asOf: new Date(2026, 4, 1),
      });

      // No foreign data: no events, and every month delta is zero. The leverId is
      // echoed (it is client-supplied, not foreign data).
      expect(delta.leverId).toBe('lp');
      expect(delta.events).toEqual([]);
      for (const m of delta.byMonth) {
        expect(m.incomeDelta).toBe('0.00');
        expect(m.expenseDelta).toBe('0.00');
      }
      // Defensive: A's comment must appear nowhere in the serialized result.
      expect(JSON.stringify(delta)).not.toContain('A-SECRET-LOAN-COMMENT');
    });
  });

  it('removes active loan_insurance occurrences alongside the installments', async () => {
    await withRollback(async (db: DbExecutor) => {
      const accountService = new AccountService(db);
      const loanFlowService = new LoanFlowService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'payoff-ins@test.com', name: 'P', passwordHash: 'h' })
        .returning();
      const checking = await accountService.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });

      // 3 remaining installments (Jun/Jul/Aug) PLUS a monthly seguro of 50.00 on
      // the same loan — the materializer emits loan_insurance occurrences the
      // payoff resolver must also strip from the months they fall in.
      const { account, insuranceSchedule } = await loanFlowService.createLoan(user.id, {
        name: 'CDC Seguro',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '1000.00',
        totalInstallments: 3,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 5, 10), // Jun 2026
        checkingAccountId: checking.id,
        monthlyInterestRate: '0.02000000',
        payoffCalculationType: 'sem_desconto',
        insuranceAmount: '50.00',
        insurancePaymentDay: 10,
      });
      // Guard: the seguro schedule was actually created (the seam under test).
      expect(insuranceSchedule).not.toBeNull();

      const months = horizonMonths({ month: 6, year: 2026 }, 6); // Jun..Nov 2026
      const lever: SimLever = {
        kind: 'loan_payoff',
        id: 'lp',
        loanAccountId: account.id,
        targetMonth: { month: 6, year: 2026 },
      };

      // asOf is May 2026 so the June targetMonth is a FUTURE month (the
      // current-month guard does not fire).
      const delta = await resolveLoanPayoff(db, user.id, lever, {
        months,
        horizon: 6,
        asOf: new Date(2026, 4, 1),
      });

      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      // Jul/Aug each remove one 1000 installment AND one 50 seguro = -1050.00.
      // (Proves the resolver strips the seguro in addition to the installment.)
      expect(byKey.get('2026-7')?.expenseDelta).toBe('-1050.00');
      expect(byKey.get('2026-8')?.expenseDelta).toBe('-1050.00');
      // The installments end in Aug, but the seguro schedule is open-ended — so
      // Sep onward still removes the ongoing -50.00 seguro the payoff cancels.
      expect(byKey.get('2026-9')?.expenseDelta).toBe('-50.00');
      expect(byKey.get('2026-10')?.expenseDelta).toBe('-50.00');

      // Jun: -1000 installment - 50 seguro + 3000 sem_desconto lump = 1950.00.
      expect(byKey.get('2026-6')?.expenseDelta).toBe('1950.00');
    });
  });

  it('current-month targetMonth: returns an all-zero delta with a future-month reason annotation', async () => {
    await withRollback(async (db: DbExecutor) => {
      const accountService = new AccountService(db);
      const loanFlowService = new LoanFlowService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'payoff-current@test.com', name: 'P', passwordHash: 'h' })
        .returning();
      const checking = await accountService.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const { account } = await loanFlowService.createLoan(user.id, {
        name: 'CDC',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '1000.00',
        totalInstallments: 3,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 5, 10), // Jun 2026
        checkingAccountId: checking.id,
        monthlyInterestRate: '0.02000000',
        payoffCalculationType: 'sem_desconto',
      });

      const months = horizonMonths({ month: 6, year: 2026 }, 6); // Jun..Nov 2026
      // asOf June 2026 makes the June targetMonth the CURRENT calendar month, so the
      // guard fires: the current-month baseline loan bucket and this resolver's raw
      // subtraction could diverge → no-op instead of risking a double-count.
      const asOf = new Date(2026, 5, 1);
      const lever: SimLever = {
        kind: 'loan_payoff',
        id: 'lp',
        loanAccountId: account.id,
        targetMonth: { month: asOf.getMonth() + 1, year: asOf.getFullYear() },
      };

      const delta = await resolveLoanPayoff(db, user.id, lever, { months, horizon: 6, asOf });

      // Every month is zero — no installment subtraction, no lump sum.
      expect(delta.byMonth).toHaveLength(6);
      for (const m of delta.byMonth) {
        expect(m.incomeDelta).toBe('0.00');
        expect(m.expenseDelta).toBe('0.00');
      }
      // A single annotation event surfaces the reason on the target month.
      expect(delta.events).toHaveLength(1);
      expect(delta.events[0]).toMatchObject({
        month: 6,
        year: 2026,
        sign: 'outflow',
        amount: '0.00',
      });
      expect(delta.events[0]?.label).toMatch(/future/i);
    });
  });

  it('future-month targetMonth still applies the payoff (guard does not fire)', async () => {
    await withRollback(async (db: DbExecutor) => {
      const accountService = new AccountService(db);
      const loanFlowService = new LoanFlowService(db);
      const [user] = await db
        .insert(userProfiles)
        .values({ email: 'payoff-future@test.com', name: 'P', passwordHash: 'h' })
        .returning();
      const checking = await accountService.create(user.id, {
        name: 'Bank',
        type: 'checking',
        currency: 'BRL',
      });
      const { account } = await loanFlowService.createLoan(user.id, {
        name: 'CDC',
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '1000.00',
        totalInstallments: 3,
        currentInstallment: 1,
        dueDay: 10,
        startDate: new Date(2026, 5, 10), // Jun 2026
        checkingAccountId: checking.id,
        monthlyInterestRate: '0.02000000',
        payoffCalculationType: 'sem_desconto',
      });

      const months = horizonMonths({ month: 6, year: 2026 }, 6); // Jun..Nov 2026
      const lever: SimLever = {
        kind: 'loan_payoff',
        id: 'lp',
        loanAccountId: account.id,
        targetMonth: { month: 6, year: 2026 },
      };

      // asOf May 2026: the June targetMonth is FUTURE, so the payoff applies exactly
      // as before (lump sum + installment removal).
      const delta = await resolveLoanPayoff(db, user.id, lever, {
        months,
        horizon: 6,
        asOf: new Date(2026, 4, 1),
      });

      const byKey = new Map(delta.byMonth.map((m) => [`${m.year}-${m.month}`, m]));
      expect(byKey.get('2026-7')?.expenseDelta).toBe('-1000.00');
      expect(byKey.get('2026-8')?.expenseDelta).toBe('-1000.00');
      // Jun: -1000 installment + 3000 sem_desconto lump = 2000.00.
      expect(byKey.get('2026-6')?.expenseDelta).toBe('2000.00');
      expect(delta.events).toHaveLength(1);
      expect(delta.events[0]).toMatchObject({ month: 6, year: 2026, amount: '3000.00' });
    });
  });
});
