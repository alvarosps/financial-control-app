import type { DbExecutor } from '@fc/db';
import { accounts, scheduledTransactions, transactions } from '@fc/db';
import { Money } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { assertCardWriteContext, type CardWriteContext } from '../lib/card-write-context.ts';
import { errorCause } from '../lib/error-codes.ts';
import { financialRevision } from '../lib/financial-revision.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import {
  assertNoPayrollAllocation,
  assertNotPayrollLoan,
  assertOpenSettlementPeriods,
  settlementDateKey,
} from '../lib/settlement-guards.ts';

type Leg = 'source' | 'destination';
type SettlementInput = {
  transactionId: string;
  walletAccountId: string;
  leg: Leg;
  amountOverrideBrl?: string;
  settlementDate?: Date;
  settlementSource?: 'manual' | 'bank' | 'date_assumed';
  expectedRevision?: string;
};

export function assertNotBillPayment(domainType: string | null): void {
  if (domainType === 'bill_payment')
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Bill payments require a reviewed repair; generic undo is unavailable.',
      cause: errorCause('bill.paymentRepairRequired'),
    });
}

export class SettlementService {
  constructor(private db: DbExecutor) {}

  async settle(userId: string, params: SettlementInput) {
    return runWithMaterializationLock(this.db, userId, ({ db }) =>
      new SettlementService(db).settleInternal(userId, params),
    );
  }

  async settleBillPayment(
    context: CardWriteContext,
    userId: string,
    params: {
      transactionId: string;
      walletAccountId: string;
      settledAt: Date;
      settlementSource?: 'manual' | 'bank';
    },
  ) {
    assertCardWriteContext(context, userId);
    return runWithMaterializationLock(this.db, userId, ({ db }) =>
      new SettlementService(db).settleInternal(
        userId,
        { ...params, leg: 'source' },
        params.settledAt,
      ),
    );
  }

  private async settleInternal(userId: string, params: SettlementInput, billPaymentAt?: Date) {
    const { transactionId, walletAccountId, leg, amountOverrideBrl } = params;

    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)))
      .for('update');
    if (!tx) throw new TRPCError({ code: 'NOT_FOUND', message: 'Transaction not found' });
    if (params.expectedRevision && params.expectedRevision !== financialRevision(tx))
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Occurrence changed. Reload before recording payment.',
      });
    if (!billPaymentAt) assertNotBillPayment(tx.domainType);
    await assertNoPayrollAllocation(this.db, userId, transactionId);
    await assertNotPayrollLoan(this.db, tx.destinationAccountId, tx.domainType);
    if ((tx.isPaid && tx.settlementSource !== 'date_assumed') || tx.isReversed)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Occurrence is already settled or reversed',
      });
    const recordedAt = new Date();
    const effectiveAt = params.settlementDate ?? billPaymentAt ?? recordedAt;
    if (!Number.isFinite(effectiveAt.getTime()) || effectiveAt > recordedAt)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid effective settlement date' });
    await assertOpenSettlementPeriods(this.db, userId, [
      tx.date.toISOString().slice(0, 10),
      settlementDateKey(effectiveAt),
    ]);

    const [wallet] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, walletAccountId), eq(accounts.userId, userId)));
    if (!wallet) throw new TRPCError({ code: 'NOT_FOUND', message: 'Wallet account not found' });
    if (
      (params.settlementDate || billPaymentAt) &&
      wallet.openingBalanceAnchorAt &&
      effectiveAt <= wallet.openingBalanceAnchorAt
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Effective date precedes the reconciled wallet anchor; reviewed repair required',
      });
    if (
      !params.settlementDate &&
      !billPaymentAt &&
      wallet.openingBalanceAnchorAt &&
      tx.date.toISOString().slice(0, 10) < settlementDateKey(wallet.openingBalanceAnchorAt)
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          'Historical occurrence requires an explicit payment date and reviewed reconciliation when already included in the balance.',
      });
    if (
      billPaymentAt &&
      (tx.domainType !== 'bill_payment' ||
        tx.isPaid ||
        tx.isReversed ||
        tx.sourceAccountId !== wallet.id ||
        wallet.type !== 'checking' ||
        !wallet.isActive ||
        tx.currency !== 'BRL' ||
        wallet.currency !== tx.currency ||
        tx.date.toISOString().slice(0, 10) !== billPaymentAt.toISOString().slice(0, 10) ||
        (wallet.openingBalanceAnchorAt && wallet.openingBalanceAnchorAt >= billPaymentAt))
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Invalid bill payment wallet or settlement.',
        cause: errorCause('bill.invalidPaymentWallet'),
      });
    }
    if (wallet.type !== 'checking') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Wallet must be a checking account',
      });
    }
    if (!wallet.isActive || wallet.currency !== 'BRL')
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select an active BRL wallet' });
    if (tx.currency !== 'BRL' && amountOverrideBrl === undefined)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'A realized BRL amount is required' });
    const cash = Money.fromString(amountOverrideBrl ?? tx.amount, 'BRL');
    if (!Number.isFinite(cash.toNumber()) || cash.toNumber() < 0)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid cash amount' });

    const updates: Record<string, unknown> = {
      isPaid: true,
      paidAt: recordedAt,
      paidFromAccountId: walletAccountId,
      cashAmount: cash.toDbString(),
      settlementSource: params.settlementSource ?? 'manual',
      settlementDate: effectiveAt,
      updatedAt: recordedAt,
    };
    if (leg === 'source') updates.sourceAccountId = walletAccountId;
    else updates.destinationAccountId = walletAccountId;

    const [updated] = await this.db
      .update(transactions)
      .set(updates)
      .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)))
      .returning();
    return updated;
  }

  async unsettle(userId: string, transactionId: string) {
    return runWithMaterializationLock(this.db, userId, ({ db }) =>
      new SettlementService(db).unsettleInternal(userId, transactionId),
    );
  }

  private async unsettleInternal(userId: string, transactionId: string) {
    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)))
      .for('update');
    if (!tx) throw new TRPCError({ code: 'NOT_FOUND', message: 'Transaction not found' });
    if (tx.paidFromAccountId && tx.settlementDate) {
      const [wallet] = await this.db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.id, tx.paidFromAccountId)));
      if (wallet?.openingBalanceAnchorAt && tx.settlementDate <= wallet.openingBalanceAnchorAt)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Historical settlement requires a reviewed repair to undo',
        });
    }
    assertNotBillPayment(tx.domainType);
    await assertNoPayrollAllocation(this.db, userId, transactionId);
    await assertOpenSettlementPeriods(this.db, userId, [
      tx.date.toISOString().slice(0, 10),
      ...(tx.settlementDate ? [settlementDateKey(tx.settlementDate)] : []),
    ]);

    const updates: Record<string, unknown> = {
      isPaid: false,
      paidAt: null,
      paidFromAccountId: null,
      cashAmount: null,
      settlementSource: 'legacy',
      settlementDate: null,
      updatedAt: new Date(),
    };

    if (tx.scheduledTransactionId) {
      const [sched] = await this.db
        .select()
        .from(scheduledTransactions)
        .where(
          and(
            eq(scheduledTransactions.id, tx.scheduledTransactionId),
            eq(scheduledTransactions.userId, userId),
          ),
        );
      if (sched) {
        updates.sourceAccountId = sched.sourceAccountId;
        updates.destinationAccountId = sched.destinationAccountId;
        if (tx.cashAmount === null) {
          updates.amount = sched.amount;
          updates.currency = sched.currency;
          updates.exchangeRate = null;
        }
      }
    }

    const [updated] = await this.db
      .update(transactions)
      .set(updates)
      .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)))
      .returning();
    return updated;
  }
}
