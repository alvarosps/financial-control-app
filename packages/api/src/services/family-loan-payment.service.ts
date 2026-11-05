import type { DbExecutor } from '@fc/db';
import { accounts, transactions } from '@fc/db';
import { Money } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { assertOpenSettlementPeriods, settlementDateKey } from '../lib/settlement-guards.ts';

import { AuditService } from './audit.service.ts';
import { loadFamilyLoanConfig } from './family-loan-shared.ts';

/**
 * Pagamentos de empréstimo familiar: registrar, listar e estornar.
 * Extraído de FamilyLoanFlowService (que delega para cá) — comportamento
 * byte-a-byte idêntico.
 */
export class FamilyLoanPaymentService {
  constructor(private db: DbExecutor) {}

  async recordPayment(
    userId: string,
    input: {
      configId: string;
      amount: string;
      date: Date;
      walletAccountId: string;
      notes?: string;
    },
  ) {
    return runWithMaterializationLock(this.db, userId, ({ db }) =>
      new FamilyLoanPaymentService(db).recordPaymentInternal(userId, input),
    );
  }

  private async recordPaymentInternal(
    userId: string,
    input: {
      configId: string;
      amount: string;
      date: Date;
      walletAccountId: string;
      notes?: string;
    },
  ) {
    const effectiveDate = new Date(`${input.date.toISOString().slice(0, 10)}T00:00:00-03:00`);
    const config = await loadFamilyLoanConfig(this.db, userId, input.configId);
    const [wallet] = await this.db
      .select({
        id: accounts.id,
        type: accounts.type,
        currency: accounts.currency,
        anchor: accounts.openingBalanceAnchorAt,
        isActive: accounts.isActive,
      })
      .from(accounts)
      .where(and(eq(accounts.id, input.walletAccountId), eq(accounts.userId, userId)));
    if (!wallet) throw new TRPCError({ code: 'NOT_FOUND', message: 'Wallet account not found' });
    if (wallet.type !== 'checking' || wallet.currency !== 'BRL' || !wallet.isActive) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Wallet must be a BRL checking account',
      });
    }
    const amount = Money.fromString(input.amount, 'BRL');
    if (amount.isZero() || amount.isNegative()) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Payment amount must be positive' });
    }
    if (!Number.isFinite(input.date.getTime()) || input.date > new Date())
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid receipt date' });
    if (wallet.anchor && effectiveDate <= wallet.anchor)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Receipt precedes the reconciled wallet anchor; reviewed repair required',
      });
    await assertOpenSettlementPeriods(this.db, userId, [settlementDateKey(effectiveDate)]);

    const [row] = await this.db
      .insert(transactions)
      .values({
        userId,
        sourceAccountId: config.accountId,
        destinationAccountId: input.walletAccountId,
        amount: amount.toDbString(),
        currency: 'BRL',
        type: 'deposit',
        description: input.notes?.trim() || 'Pagamento recebido',
        date: input.date,
        isPaid: true,
        paidAt: new Date(),
        cashAmount: amount.toDbString(),
        settlementSource: 'manual',
        settlementDate: effectiveDate,
        paidFromAccountId: input.walletAccountId,
        domainType: 'family_loan_payment',
      })
      .returning();
    await new AuditService(this.db).log(userId, 'create', 'transaction', row.id, undefined, {
      kind: 'family_loan_payment',
      configId: config.id,
      amount: amount.toDbString(),
    });
    return row;
  }

  async listPayments(userId: string, configId: string) {
    const config = await loadFamilyLoanConfig(this.db, userId, configId);
    return this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.sourceAccountId, config.accountId),
          eq(transactions.domainType, 'family_loan_payment'),
          eq(transactions.isReversed, false),
        ),
      )
      .orderBy(transactions.date);
  }

  async reversePayment(userId: string, transactionId: string) {
    return runWithMaterializationLock(this.db, userId, ({ db }) =>
      new FamilyLoanPaymentService(db).reversePaymentInternal(userId, transactionId),
    );
  }

  private async reversePaymentInternal(userId: string, transactionId: string) {
    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.id, transactionId),
          eq(transactions.userId, userId),
          eq(transactions.domainType, 'family_loan_payment'),
        ),
      );
    if (!tx) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family loan payment not found' });
    if (tx.isReversed)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Payment already reversed' });
    await assertOpenSettlementPeriods(this.db, userId, [
      tx.date.toISOString().slice(0, 10),
      ...(tx.settlementDate ? [settlementDateKey(tx.settlementDate)] : []),
    ]);
    const [updated] = await this.db
      .update(transactions)
      .set({ isReversed: true, reversedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)))
      .returning();
    await new AuditService(this.db).log(
      userId,
      'reverse',
      'transaction',
      transactionId,
      undefined,
      {
        kind: 'family_loan_payment',
      },
    );
    return updated;
  }
}
