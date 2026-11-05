import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '@fc/db';
import {
  accounts,
  externalAccounts,
  externalConnections,
  externalMovements,
  loanConfigs,
  monthClosings,
  transactions,
} from '@fc/db';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { BankReconciliationService } from './bank-reconciliation.service.ts';
import { CashReadinessService } from './cash-readiness.service.ts';
import { FinancialAlertService } from './financial-alert.service.ts';
import { LoanFlowService } from './loan-flow.service.ts';
import { MonthClosingService } from './month-closing.service.ts';
import { PayrollSettlementService } from './payroll-settlement.service.ts';
import { pluggyTransactionSchema } from './pluggy/pluggy-types.ts';

const day = new Date('2026-09-25T15:00:00Z');
async function fixture(db: DbExecutor) {
  const user = await createTestUser(db);
  const [wallet, other, income, loan, card, additional, family] = await db
    .insert(accounts)
    .values(
      (
        [
          'checking',
          'checking',
          'revenue',
          'loan',
          'credit_card',
          'credit_card',
          'family_loan',
        ] as const
      ).map((type, i) => ({
        userId: user.id,
        type,
        name: `Fixture ${i}`,
        currency: 'BRL',
        openingBalance: '0.00',
        overdraftLimit: type === 'checking' ? '23000.00' : null,
      })),
    )
    .returning();
  const [connection] = await db
    .insert(externalConnections)
    .values({ userId: user.id, itemId: randomUUID(), name: 'Fixture' })
    .returning();
  const [external] = await db
    .insert(externalAccounts)
    .values({
      userId: user.id,
      connectionId: connection.id,
      externalId: randomUUID(),
      accountId: wallet.id,
      kind: 'BANK',
      name: 'Fixture',
      currency: 'BRL',
      balance: '-9951.85',
      sourceUpdatedAt: day,
      fetchedAt: day,
    })
    .returning();
  const movement = async (amount: number, type: 'CREDIT' | 'DEBIT', externalAccount = external) => {
    const id = randomUUID();
    const [row] = await db
      .insert(externalMovements)
      .values({
        userId: user.id,
        externalAccountId: externalAccount.id,
        externalId: id,
        contentHash: 'a'.repeat(64),
        sourceUpdatedAt: day,
        payload: {
          id,
          accountId: externalAccount.externalId,
          description: 'Bank fixture',
          amount,
          currencyCode: 'BRL',
          type,
          status: 'POSTED',
          date: '2026-09-25',
          createdAt: day.toISOString(),
          updatedAt: day.toISOString(),
        },
      })
      .returning();
    return { ...row, payload: pluggyTransactionSchema.parse(row.payload) };
  };
  const ledger = async (
    amount: string,
    destinationAccountId: string,
    sourceAccountId = wallet.id,
    domainType: typeof transactions.$inferInsert.domainType = 'loan_payment',
  ) => {
    const [row] = await db
      .insert(transactions)
      .values({
        userId: user.id,
        sourceAccountId,
        destinationAccountId,
        amount,
        currency: 'BRL',
        type: sourceAccountId === wallet.id ? 'withdrawal' : 'deposit',
        domainType,
        description: 'Existing payment',
        date: new Date('2026-09-25'),
        isPaid: true,
        paidAt: day,
        settlementDate: day,
        settlementSource: 'manual',
        cashAmount: amount,
      })
      .returning();
    return row;
  };
  return {
    user,
    wallet,
    other,
    income,
    loan,
    card,
    additional,
    family,
    external,
    connection,
    movement,
    ledger,
    service: new BankReconciliationService(db),
  };
}
describe('BankReconciliationService', () => {
  it('withholds cash readiness, payoff cash and projections until a posted bank movement is reconciled', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const asOf = new Date('2026-09-28T15:00:00Z');
      await db
        .update(accounts)
        .set({
          openingBalance: '500.00',
          cashAnchorBasis: 'effective',
          openingBalanceAnchorAt: new Date('2026-09-24T15:00:00Z'),
        })
        .where(and(eq(accounts.userId, f.user.id), eq(accounts.type, 'checking')));
      await db.insert(loanConfigs).values({
        accountId: f.loan.id,
        loanCategory: 'bank',
        loanType: 'pessoal',
        monthlyPayment: '100.00',
        totalInstallments: 12,
        dueDay: 10,
        monthlyInterestRate: '0',
      });
      const movement = await f.movement(-500, 'DEBIT');
      const readiness = new CashReadinessService(db);
      expect(await readiness.get(f.user.id, asOf)).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining(['unreconciled_bank_evidence']),
      });
      expect(await new LoanFlowService(db).getPayoffInfo(f.user.id, f.loan.id, asOf)).toMatchObject(
        { cashReady: false, availableCash: null },
      );
      const alerts = (await new FinancialAlertService(db, () => asOf).refresh(f.user.id)).items;
      expect(alerts.map((a) => a.rule)).toContain('cash_coverage');
      expect(alerts.map((a) => a.rule)).not.toContain('projected_commitment');
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toEqual([]);
      const payment = await f.ledger('500.00', f.loan.id);
      const detail = await f.service.detail(f.user.id, movement.id);
      await f.service.link(f.user.id, {
        movementId: movement.id,
        version: 1,
        allocations: detail.candidates.map(({ transactionId, fingerprint }) => ({
          transactionId,
          fingerprint,
        })),
      });
      expect(await readiness.get(f.user.id, asOf)).toMatchObject({
        ready: true,
        cash: { totalCash: 500 },
      });
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, payment.id)))[0].amount,
      ).toBe('500.00');
    });
  });
  it.each([
    'changed',
    'retracted',
  ] as const)('invalidates ready cash for %s linked evidence', async (state) => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const asOf = new Date('2026-09-28T15:00:00Z');
      await db
        .update(accounts)
        .set({
          cashAnchorBasis: 'effective',
          openingBalanceAnchorAt: new Date('2026-09-24T15:00:00Z'),
        })
        .where(and(eq(accounts.userId, f.user.id), eq(accounts.type, 'checking')));
      const movement = await f.movement(-100, 'DEBIT');
      await f.ledger('100.00', f.loan.id);
      const detail = await f.service.detail(f.user.id, movement.id);
      await f.service.link(f.user.id, {
        movementId: movement.id,
        version: 1,
        allocations: detail.candidates.map(({ transactionId, fingerprint }) => ({
          transactionId,
          fingerprint,
        })),
      });
      const readiness = new CashReadinessService(db);
      expect((await readiness.get(f.user.id, asOf)).ready).toBe(true);
      await db
        .update(externalMovements)
        .set({
          version: 2,
          ...(state === 'retracted'
            ? { retractedAt: asOf }
            : { payload: { ...movement.payload, date: '2026-09-01', amount: -150 } }),
        })
        .where(eq(externalMovements.id, movement.id));
      expect(await readiness.get(f.user.id, asOf)).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining(['unreconciled_bank_evidence']),
      });
    });
  });
  it('scopes bank readiness by owner and individual anchor and reports bounded coverage', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db),
        foreign = await fixture(db);
      const asOf = new Date('2026-09-28T15:00:00Z');
      await db
        .update(accounts)
        .set({
          cashAnchorBasis: 'effective',
          openingBalanceAnchorAt: new Date('2026-09-26T15:00:00Z'),
        })
        .where(and(eq(accounts.userId, f.user.id), eq(accounts.type, 'checking')));
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2026-09-23T15:00:00Z') })
        .where(eq(accounts.id, f.other.id));
      const prior = await f.movement(-100, 'DEBIT');
      await foreign.movement(-100, 'DEBIT');
      const future = await f.movement(-100, 'DEBIT');
      await db
        .update(externalMovements)
        .set({ payload: { ...future.payload, date: '2026-09-29' } })
        .where(eq(externalMovements.id, future.id));
      const readiness = new CashReadinessService(db);
      expect((await readiness.get(f.user.id, asOf)).ready).toBe(true);
      await db
        .update(externalAccounts)
        .set({ accountId: null })
        .where(eq(externalAccounts.id, f.external.id));
      expect((await readiness.get(f.user.id, asOf)).ready).toBe(false);
      await db
        .update(externalAccounts)
        .set({ accountId: f.wallet.id })
        .where(eq(externalAccounts.id, f.external.id));
      await db
        .update(externalMovements)
        .set({ payload: { ...prior.payload, date: '2026-09-26' } })
        .where(eq(externalMovements.id, prior.id));
      expect((await readiness.get(f.user.id, asOf)).ready).toBe(false);
      await db.insert(externalMovements).values(
        Array.from({ length: 251 }, () => {
          const id = randomUUID();
          return {
            userId: f.user.id,
            externalAccountId: f.external.id,
            externalId: id,
            contentHash: 'b'.repeat(64),
            sourceUpdatedAt: asOf,
            payload: { ...future.payload, id, date: '2026-09-27' },
          };
        }),
      );
      expect(await readiness.get(f.user.id, asOf)).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining(['bank_evidence_overflow']),
      });
    });
  });
  it('retains changed bank evidence by its linked Sao Paulo settlement day across a UTC month boundary', async () => {
    await withRollback(async (db) => {
      await db.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
      const f = await fixture(db);
      const payment = await f.ledger('100.00', f.loan.id);
      await db
        .update(transactions)
        .set({ date: new Date('2026-08-10'), settlementDate: new Date('2026-09-01T02:00:00Z') })
        .where(eq(transactions.id, payment.id));
      const movement = await f.movement(-100, 'DEBIT');
      await db
        .update(externalMovements)
        .set({ payload: { ...movement.payload, date: '2026-08-31' } })
        .where(eq(externalMovements.id, movement.id));
      const detail = await f.service.detail(f.user.id, movement.id);
      await f.service.link(f.user.id, {
        movementId: movement.id,
        version: 1,
        allocations: detail.candidates.map(({ transactionId, fingerprint }) => ({
          transactionId,
          fingerprint,
        })),
      });
      await db
        .update(externalMovements)
        .set({ version: 2, payload: { ...movement.payload, date: '2026-09-02' } })
        .where(eq(externalMovements.id, movement.id));
      expect(
        (await f.service.closingEvidence(f.user.id, '2026-08-01', '2026-08-31')).items,
      ).toContainEqual(expect.objectContaining({ id: movement.id, state: 'needs_review' }));
      expect((await new MonthClosingService(db).preview(f.user.id, 8, 2026)).items).toContainEqual(
        expect.objectContaining({ key: 'bank_movements', severity: 'critical' }),
      );
    });
  });
  it('does not infer an incoming direction when institution type is missing', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await f.ledger('100', f.wallet.id, f.income.id, 'income_clt');
      const row = await f.movement(100, 'CREDIT');
      await db
        .update(externalMovements)
        .set({ payload: sql`${externalMovements.payload} - 'type'` })
        .where(eq(externalMovements.id, row.id));
      const detail = await f.service.detail(f.user.id, row.id);
      expect(detail.reviewable).toBe(false);
      expect(detail.candidates).toHaveLength(0);
    });
  });
  it('writes and revokes links under the owner RLS context and rejects cross-owner targets', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db),
        foreign = await fixture(db);
      const payment = await f.ledger('100', f.loan.id);
      const other = await foreign.ledger('100', foreign.loan.id);
      const movement = await f.movement(-100, 'DEBIT');
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${f.user.id}, true)`);
        const service = new BankReconciliationService(tx);
        const detail = await service.detail(f.user.id, movement.id);
        const input = {
          movementId: movement.id,
          version: 1,
          allocations: detail.candidates.map(({ transactionId, fingerprint }) => ({
            transactionId,
            fingerprint,
          })),
        };
        expect(detail.candidates[0].transactionId).toBe(payment.id);
        await expect(
          service.link(f.user.id, {
            ...input,
            allocations: [
              { transactionId: other.id, fingerprint: detail.candidates[0].fingerprint },
            ],
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((await service.link(f.user.id, input)).state).toBe('linked');
        expect(
          (
            await service.unlink(f.user.id, {
              movementId: movement.id,
              version: 1,
              reason: 'Review again',
            })
          ).state,
        ).toBe('pending');
        await tx.execute(sql`RESET ROLE`);
      });
    });
  });
  it('links the net payroll deposit and bank debit without duplicating income or payroll deductions', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await db.insert(loanConfigs).values({
        accountId: f.loan.id,
        loanCategory: 'bank',
        loanType: 'consignado',
        monthlyPayment: '1000',
        monthlyInterestRate: '0',
        totalInstallments: 12,
        dueDay: 25,
        paymentMethod: 'payroll',
        incomeSourceAccountId: f.income.id,
      });
      const salary = await f.ledger('10000', f.wallet.id, f.income.id, 'income_clt');
      const deduction = await f.ledger('1000', f.loan.id);
      await db
        .update(transactions)
        .set({ isPaid: false, paidAt: null, settlementDate: null, cashAmount: null })
        .where(sql`${transactions.id} IN (${salary.id}, ${deduction.id})`);
      await new PayrollSettlementService(db, () => new Date('2026-09-26T15:00:00Z')).settle(
        f.user.id,
        {
          incomeTransactionId: salary.id,
          loanTransactionIds: [deduction.id],
          walletAccountId: f.wallet.id,
          settlementDate: day,
        },
      );
      const deposit = await f.movement(9000, 'CREDIT');
      const detail = await f.service.detail(f.user.id, deposit.id);
      expect(detail.candidates).toHaveLength(1);
      expect(detail.candidates[0]).toMatchObject({ transactionId: salary.id, amount: '9000.00' });
      await f.service.link(f.user.id, {
        movementId: deposit.id,
        version: 1,
        allocations: detail.candidates.map(({ transactionId, fingerprint }) => ({
          transactionId,
          fingerprint,
        })),
      });
      expect((await f.service.detail(f.user.id, deposit.id)).state).toBe('linked');
      const debitRow = await f.ledger('500', f.other.id);
      const debit = await f.movement(-500, 'DEBIT');
      const review = await f.service.detail(f.user.id, debit.id);
      expect(review.candidates.map((c) => c.transactionId)).toEqual([debitRow.id]);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(3);
    });
  });
  it('requires full aggregated allocations and prevents reuse, stale review and silent changes', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const first = await f.ledger('100', f.card.id, f.wallet.id, 'bill_payment');
      await f.ledger('50', f.additional.id, f.wallet.id, 'bill_payment');
      const movement = await f.movement(-150, 'DEBIT');
      const detail = await f.service.detail(f.user.id, movement.id);
      const input = {
        movementId: movement.id,
        version: 1,
        allocations: detail.candidates.map(({ transactionId, fingerprint }) => ({
          transactionId,
          fingerprint,
        })),
      };
      await expect(
        f.service.link(f.user.id, { ...input, allocations: input.allocations.slice(0, 1) }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(f.service.link(f.user.id, { ...input, version: 2 })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await f.service.link(f.user.id, input);
      await expect(f.service.link(f.user.id, input)).rejects.toMatchObject({ code: 'CONFLICT' });
      const duplicate = await f.movement(-150, 'DEBIT');
      expect((await f.service.detail(f.user.id, duplicate.id)).candidates).toHaveLength(0);
      await db.update(transactions).set({ cashAmount: '101' }).where(eq(transactions.id, first.id));
      expect((await f.service.detail(f.user.id, movement.id)).state).toBe('needs_review');
      await f.service.unlink(f.user.id, {
        movementId: movement.id,
        version: 1,
        reason: 'Corrected payment',
      });
      expect((await f.service.detail(f.user.id, movement.id)).state).toBe('pending');
      await expect(f.service.link(f.user.id, input)).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });
  it('links both legs of an own transfer and an existing family receipt without adding ledger rows', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const transfer = await f.ledger('100', f.other.id, f.wallet.id, null);
      const [externalOther] = await db
        .insert(externalAccounts)
        .values({
          ...f.external,
          id: randomUUID(),
          externalId: randomUUID(),
          accountId: f.other.id,
        })
        .returning();
      const outgoing = await f.movement(-100, 'DEBIT');
      const incoming = await f.movement(100, 'CREDIT', externalOther);
      for (const movement of [outgoing, incoming]) {
        const detail = await f.service.detail(f.user.id, movement.id);
        expect(detail.candidates[0].transactionId).toBe(transfer.id);
        await f.service.link(f.user.id, {
          movementId: movement.id,
          version: 1,
          allocations: detail.candidates.map(({ transactionId, fingerprint }) => ({
            transactionId,
            fingerprint,
          })),
        });
      }
      const family = await f.ledger('200', f.wallet.id, f.family.id, 'family_loan_payment');
      const receipt = await f.movement(200, 'CREDIT');
      const review = await f.service.detail(f.user.id, receipt.id);
      expect(review.candidates[0].transactionId).toBe(family.id);
      await f.service.link(f.user.id, {
        movementId: receipt.id,
        version: 1,
        allocations: review.candidates.map(({ transactionId, fingerprint }) => ({
          transactionId,
          fingerprint,
        })),
      });
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(2);
    });
  });
  it('keeps provider revisions and tombstones visible and blocks closed-month or foreign review', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db),
        foreign = await fixture(db);
      await f.ledger('100', f.loan.id);
      const movement = await f.movement(-100, 'DEBIT');
      const detail = await f.service.detail(f.user.id, movement.id);
      const input = {
        movementId: movement.id,
        version: 1,
        allocations: detail.candidates.map(({ transactionId, fingerprint }) => ({
          transactionId,
          fingerprint,
        })),
      };
      await expect(f.service.detail(foreign.user.id, movement.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await db
        .insert(monthClosings)
        .values({ userId: f.user.id, month: 9, year: 2026, status: 'closed' });
      await expect(f.service.link(f.user.id, input)).rejects.toMatchObject({ code: 'CONFLICT' });
      await new MonthClosingService(db).reopenMonth(
        f.user.id,
        9,
        2026,
        'Review bank reconciliation',
      );
      await f.service.link(f.user.id, input);
      await db
        .update(externalMovements)
        .set({ version: 2, retractedAt: day })
        .where(eq(externalMovements.id, movement.id));
      expect((await f.service.detail(f.user.id, movement.id)).state).toBe('needs_review');
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toHaveLength(1);
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(sql`SELECT set_config('app.current_user_id',${foreign.user.id},true)`);
        expect(await tx.execute(sql`SELECT * FROM bank_reconciliation_links`)).toHaveLength(0);
        await tx.execute(sql`RESET ROLE`);
      });
    });
  });
  it('compares only dated book balances and never adds overdraft or overwrites the anchor', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      expect(await f.service.balance(f.user.id, f.external.id)).toMatchObject({
        comparable: false,
        reason: 'unknown_balance_type',
      });
      await db
        .update(externalAccounts)
        .set({ balanceType: 'book' })
        .where(eq(externalAccounts.id, f.external.id));
      expect(await f.service.balance(f.user.id, f.external.id)).toMatchObject({
        comparable: false,
        reason: 'unknown_balance_date',
      });
      await db
        .update(externalAccounts)
        .set({ balanceAsOf: day })
        .where(eq(externalAccounts.id, f.external.id));
      expect(await f.service.balance(f.user.id, f.external.id)).toMatchObject({
        comparable: true,
        institutional: '-9951.85',
        calculated: '0.00',
        difference: '-9951.85',
      });
      const [wallet] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, f.user.id), eq(accounts.id, f.wallet.id)));
      expect(wallet.openingBalance).toBe('0.00');
    });
  });
});
