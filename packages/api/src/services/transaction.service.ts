import type { DbExecutor } from '@fc/db';
import { accounts, transactions } from '@fc/db';
import type { AccountType, DomainType } from '@fc/domain';
import {
  deriveTransactionType,
  getDomainTypesByGroup,
  NotFoundError,
  validateTransactionAccounts,
} from '@fc/domain';
import type { StatementDateSource } from '@fc/shared';
import { TRPCError } from '@trpc/server';
import { and, count, desc, eq, gte, lte, or } from 'drizzle-orm';
import { assertCardWriteContext, type CardWriteContext } from '../lib/card-write-context.ts';
import type { PaginatedResult, PaginationInput } from '../lib/pagination.ts';
import { paginate } from '../lib/pagination.ts';
import { assertNoPayrollAllocation, assertNotPayrollLoan } from '../lib/settlement-guards.ts';
import { AccountService } from './account.service.ts';
import { AuditService } from './audit.service.ts';
import { CreditCardLifecycleService } from './credit-card-lifecycle.service.ts';
import { assertNotBillPayment, SettlementService } from './settlement.service.ts';

type CreateTransactionInput = {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  description: string;
  date: Date;
  purchaseDate?: string | null;
  postedDate?: string | null;
  purchaseDateSource?: StatementDateSource;
  postedDateSource?: StatementDateSource;
  notes?: string;
  categoryId?: string;
  billingMonth?: number;
  billingYear?: number;
  installmentNumber?: number;
  totalInstallments?: number;
  domainType?: DomainType;
  exchangeRate?: string;
};

type ListByPeriodBaseInput = {
  month: number;
  year: number;
  accountId?: string;
  type?: 'deposit' | 'withdrawal' | 'transfer';
};

type ListByPeriodInput = ListByPeriodBaseInput & { page?: number; pageSize?: number };

type TransactionRow = typeof transactions.$inferSelect;

export class TransactionService {
  private accountService: AccountService;
  private auditService: AuditService;
  private cardLifecycle: CreditCardLifecycleService;

  constructor(private db: DbExecutor) {
    this.accountService = new AccountService(db);
    this.auditService = new AuditService(db);
    this.cardLifecycle = new CreditCardLifecycleService(db);
  }

  async create(userId: string, input: CreateTransactionInput) {
    return this.createInternal(userId, input, false);
  }

  async createWithinCardFlow(
    context: CardWriteContext,
    userId: string,
    input: CreateTransactionInput,
  ) {
    assertCardWriteContext(context, userId);
    return this.createInternal(userId, input, true);
  }

  private async createInternal(
    userId: string,
    input: CreateTransactionInput,
    allowCardWrite: boolean,
  ) {
    const [sourceAccount] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, input.sourceAccountId));

    const [destAccount] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, input.destinationAccountId));

    if (!sourceAccount) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Source account not found' });
    }

    if (!destAccount) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Destination account not found' });
    }

    if (sourceAccount.userId !== userId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Source account does not belong to user' });
    }

    if (destAccount.userId !== userId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Destination account does not belong to user',
      });
    }

    const isCardDomain =
      input.domainType !== undefined &&
      getDomainTypesByGroup('credit_card').includes(input.domainType);
    if (
      !allowCardWrite &&
      (isCardDomain || sourceAccount.type === 'credit_card' || destAccount.type === 'credit_card')
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'Transa\u00e7\u00f5es de cart\u00e3o exigem o fluxo espec\u00edfico do cart\u00e3o.',
      });
    }

    if (destAccount.type === 'credit_card') {
      await this.cardLifecycle.assertActiveCard(userId, destAccount.id);
    }

    const validation = validateTransactionAccounts(
      sourceAccount.type as AccountType,
      destAccount.type as AccountType,
    );

    if (!validation.valid) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: validation.reason });
    }

    const type = deriveTransactionType(
      sourceAccount.type as AccountType,
      destAccount.type as AccountType,
    );

    if (
      input.domainType !== undefined &&
      getDomainTypesByGroup('credit_card').includes(input.domainType) &&
      (input.billingMonth == null || input.billingYear == null)
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Credit-card transactions require a billing month/year',
      });
    }

    // INSERT + audit log must commit or fail together. The balance trigger
    // already recalculates both accounts after every transaction INSERT.
    return this.db.transaction(async (tx) => {
      const [transaction] = await tx
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: input.sourceAccountId,
          destinationAccountId: input.destinationAccountId,
          amount: input.amount,
          type,
          description: input.description,
          date: input.date,
          purchaseDate: input.purchaseDate,
          postedDate: input.postedDate,
          purchaseDateSource: input.purchaseDateSource,
          postedDateSource: input.postedDateSource,
          ...(input.notes !== undefined && { notes: input.notes }),
          ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
          ...(input.billingMonth !== undefined && { billingMonth: input.billingMonth }),
          ...(input.billingYear !== undefined && { billingYear: input.billingYear }),
          ...(input.installmentNumber !== undefined && {
            installmentNumber: input.installmentNumber,
          }),
          ...(input.totalInstallments !== undefined && {
            totalInstallments: input.totalInstallments,
          }),
          ...(input.domainType !== undefined && { domainType: input.domainType }),
          ...(input.exchangeRate !== undefined && { exchangeRate: input.exchangeRate }),
        })
        .returning();

      if (!transaction) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to persist transaction',
        });
      }

      await new AuditService(tx).log(userId, 'create', 'transaction', transaction.id, undefined, {
        sourceAccountId: input.sourceAccountId,
        destinationAccountId: input.destinationAccountId,
        amount: input.amount,
        type,
        description: input.description,
        date: input.date,
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.billingMonth !== undefined && { billingMonth: input.billingMonth }),
        ...(input.billingYear !== undefined && { billingYear: input.billingYear }),
        ...(input.installmentNumber !== undefined && {
          installmentNumber: input.installmentNumber,
        }),
        ...(input.totalInstallments !== undefined && {
          totalInstallments: input.totalInstallments,
        }),
        ...(input.domainType !== undefined && { domainType: input.domainType }),
        ...(input.exchangeRate !== undefined && { exchangeRate: input.exchangeRate }),
      });

      return transaction;
    });
  }

  async getById(userId: string, transactionId: string) {
    // Ownership is enforced in the WHERE clause so a non-owner gets the same
    // NOT_FOUND response as a missing row (avoids leaking row existence).
    const [transaction] = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)));

    if (!transaction) {
      throw new NotFoundError('Transação não encontrada');
    }

    return transaction;
  }

  async update(
    userId: string,
    transactionId: string,
    fields: {
      description?: string;
      amount?: string;
      categoryId?: string | null;
      date?: Date;
    },
  ) {
    // Fetch-then-guard; the UPDATE re-asserts ownership so TOCTOU can't bypass it.
    const existing = await this.getById(userId, transactionId);
    await assertNoPayrollAllocation(this.db, userId, transactionId);
    await this.assertCreditCardTransactionActive(userId, existing);

    // Only NULL-schedule one-time rows are editable here. Schedule-backed rows
    // are edited through the schedule flow; editing one occurrence would desync
    // it from its schedule (and the materializer can re-diverge it).
    if (existing.scheduledTransactionId !== null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Este lançamento é gerenciado por um agendamento; edite pelo agendamento.',
      });
    }
    if (
      existing.domainType !== 'credit_card_expense' &&
      existing.domainType !== 'credit_card_refund'
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Apenas despesas avulsas e reembolsos podem ser editados aqui.',
      });
    }

    // A paid expense already settled against its bill — lock the amount.
    if (
      existing.domainType === 'credit_card_expense' &&
      existing.isPaid &&
      fields.amount !== undefined &&
      fields.amount !== existing.amount
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Não é possível alterar o valor de uma despesa já paga.',
      });
    }

    const [updated] = await this.db
      .update(transactions)
      .set({
        ...(fields.description !== undefined && { description: fields.description }),
        ...(fields.amount !== undefined && { amount: fields.amount }),
        ...(fields.categoryId !== undefined && {
          categoryId: fields.categoryId,
          classificationSource: 'manual' as const,
          classificationReviewedAt: new Date(),
          classificationRuleId: null,
          classificationRuleVersion: null,
          classificationConfidence: null,
        }),
        ...(fields.date !== undefined && { date: fields.date }),
      })
      .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)))
      .returning();

    if (!updated) {
      throw new NotFoundError('Transação não encontrada');
    }

    // Amount changes affect both account balances. Recalculate explicitly as a
    // safeguard (the trg_recalculate_balance trigger also covers this on UPDATE).
    if (fields.amount !== undefined && fields.amount !== existing.amount) {
      await this.accountService.recalculateBalance(updated.sourceAccountId);
      await this.accountService.recalculateBalance(updated.destinationAccountId);
    }

    await this.auditService.log(
      userId,
      'update',
      'transaction',
      transactionId,
      {
        description: existing.description,
        amount: existing.amount,
        categoryId: existing.categoryId,
        date: existing.date,
      },
      {
        description: updated.description,
        amount: updated.amount,
        categoryId: updated.categoryId,
        date: updated.date,
      },
    );

    return updated;
  }

  listByPeriod(
    userId: string,
    input: ListByPeriodBaseInput & { page: number; pageSize?: number },
  ): Promise<PaginatedResult<TransactionRow>>;
  listByPeriod(userId: string, input: ListByPeriodBaseInput): Promise<TransactionRow[]>;
  async listByPeriod(
    userId: string,
    { month, year, accountId, type, page, pageSize }: ListByPeriodInput,
  ) {
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    const baseConditions = and(
      eq(transactions.userId, userId),
      eq(transactions.isReversed, false),
      gte(transactions.date, startDate),
      lte(transactions.date, endDate),
      type ? eq(transactions.type, type) : undefined,
    );

    const whereCondition =
      accountId !== undefined
        ? and(
            baseConditions,
            or(
              eq(transactions.sourceAccountId, accountId),
              eq(transactions.destinationAccountId, accountId),
            ),
          )
        : baseConditions;

    if (page === undefined) {
      return this.db
        .select()
        .from(transactions)
        .where(whereCondition)
        .orderBy(desc(transactions.date), desc(transactions.id));
    }

    const pagination: PaginationInput = { page, pageSize: pageSize ?? 50 };
    const offset = (pagination.page - 1) * pagination.pageSize;

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(transactions)
        .where(whereCondition)
        .orderBy(desc(transactions.date), desc(transactions.id))
        .limit(pagination.pageSize)
        .offset(offset),
      this.db.select({ total: count() }).from(transactions).where(whereCondition),
    ]);

    return paginate(items, total, pagination);
  }

  async reverse(userId: string, transactionId: string) {
    const original = await this.getById(userId, transactionId);
    await assertNoPayrollAllocation(this.db, userId, transactionId);
    assertNotBillPayment(original.domainType);
    await this.assertCreditCardTransactionActive(userId, original);

    if (original.isReversed) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Transaction is already reversed' });
    }

    const reversedAt = new Date();

    // Wrap insert-reversal + update-original in a single transaction so a
    // failure between them cannot leave the reversal without the flag
    // (or vice versa). Balance recalculation is handled by DB trigger
    // trg_recalculate_balance on every INSERT/UPDATE (migration 0004), so
    // no explicit recalculateBalance call is needed here.
    return this.db.transaction(async (tx) => {
      const [reversal] = await tx
        .insert(transactions)
        .values({
          userId,
          sourceAccountId: original.destinationAccountId,
          destinationAccountId: original.sourceAccountId,
          amount: original.amount,
          type: original.type,
          description: `[Reversal] ${original.description}`,
          date: original.date,
          reversesTransactionId: original.id,
        })
        .returning();

      await tx
        .update(transactions)
        .set({
          isReversed: true,
          reversedAt,
          reversedByTransactionId: reversal.id,
        })
        .where(eq(transactions.id, original.id));

      return reversal;
    });
  }

  /**
   * Credit-card items are paid via the bill-payment flow on the card page, not
   * through the generic markAsPaid/markAsUnpaid endpoints. Throwing here keeps
   * this invariant enforced in the service layer instead of the router so the
   * ownership filter and the domain-type guard live in the same place.
   */
  private guardNonCreditCardPayable(tx: typeof transactions.$inferSelect) {
    if (
      tx.domainType === 'credit_card_installment' ||
      tx.domainType === 'credit_card_fixed_charge' ||
      tx.domainType === 'bill_payment'
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'Itens de cartão de crédito devem ser pagos via "Pagar Fatura" na página do cartão',
      });
    }
  }

  private async assertCreditCardTransactionActive(
    userId: string,
    transaction: typeof transactions.$inferSelect,
  ) {
    if (
      transaction.domainType !== null &&
      getDomainTypesByGroup('credit_card').includes(transaction.domainType)
    ) {
      await this.cardLifecycle.assertActiveCard(userId, transaction.destinationAccountId);
    }
  }

  async markAsPaid(userId: string, transactionId: string, paidFromAccountId: string) {
    const transaction = await this.getById(userId, transactionId);
    await assertNoPayrollAllocation(this.db, userId, transactionId);
    await assertNotPayrollLoan(this.db, transaction.destinationAccountId, transaction.domainType);
    await this.assertCreditCardTransactionActive(userId, transaction);

    if (transaction.isPaid) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Transaction is already paid' });
    }

    this.guardNonCreditCardPayable(transaction);

    // Verify ownership of the payment account
    await this.accountService.getById(userId, paidFromAccountId);

    return new SettlementService(this.db).settle(userId, {
      transactionId,
      walletAccountId: paidFromAccountId,
      leg: transaction.type === 'deposit' ? 'destination' : 'source',
    });
  }

  async markAsUnpaid(userId: string, transactionId: string) {
    // Fetch-then-guard: we need the row to run the domain-type check, but the
    // subsequent UPDATE re-asserts ownership in its WHERE so TOCTOU between
    // the SELECT and UPDATE cannot bypass the tenant filter.
    const transaction = await this.getById(userId, transactionId);
    await assertNoPayrollAllocation(this.db, userId, transactionId);
    await this.assertCreditCardTransactionActive(userId, transaction);
    this.guardNonCreditCardPayable(transaction);

    if (!transaction.isPaid || transaction.isReversed)
      throw new NotFoundError('Transaction is not paid or has been reversed');
    return new SettlementService(this.db).unsettle(userId, transactionId);
  }
}
