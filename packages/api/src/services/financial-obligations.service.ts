import { accounts, type DbExecutor, loanConfigs, transactions } from '@fc/db';
import { Money } from '@fc/domain';
import type { FinancialObligation, FinancialObligationRef, FinancialReviewIssue } from '@fc/shared';
import { and, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { cashValueBrl } from '../lib/cash-selection.ts';
import { financialRevision } from '../lib/financial-revision.ts';
import { type MaterializationGuardLike, noOpGuard } from '../lib/materialization-guard.ts';
import { BillService } from './bill.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { IncomeOccurrenceService } from './income-occurrence.service.ts';

export class FinancialObligationsService {
  constructor(
    private db: DbExecutor,
    private guard: MaterializationGuardLike = noOpGuard,
  ) {}

  async listForDuePeriod(
    userId: string,
    month: number,
    year: number,
    accountId?: string,
    kind?: FinancialObligationRef['kind'],
  ) {
    await this.guard.ensureMaterialized(userId, month, year);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const userAccounts = await this.db.select().from(accounts).where(eq(accounts.userId, userId));
    const accountById = new Map(userAccounts.map((a) => [a.id, a]));
    const rows = await this.db
      .select({ row: transactions, brl: cashValueBrl })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isReversed, false),
          isNull(transactions.reversesTransactionId),
          gte(transactions.date, start),
          lte(transactions.date, end),
        ),
      )
      .orderBy(transactions.date, transactions.id);
    const configs = userAccounts.length
      ? await this.db
          .select()
          .from(loanConfigs)
          .where(
            inArray(
              loanConfigs.accountId,
              userAccounts.map((a) => a.id),
            ),
          )
      : [];
    const loanById = new Map(configs.map((c) => [c.accountId, c]));
    const income = await new IncomeOccurrenceService(this.db).getOccurrences(userId, month, year);
    const incomeById = new Map(
      income.flatMap((s) => s.occurrences.map((o) => [o.transactionId, o] as const)),
    );
    const unresolvedIncomeIds = new Set(
      income.flatMap((source) =>
        source.needsPayrollAllocation
          ? source.occurrences.filter((o) => o.needsPayrollAllocation).map((o) => o.transactionId)
          : [],
      ),
    );
    const items: FinancialObligation[] = [];
    const reviewIssues: FinancialReviewIssue[] = [];
    const add = (item: Omit<FinancialObligation, 'revision'>) =>
      items.push({ ...item, revision: financialRevision(item) });
    const review = (issue: FinancialReviewIssue) => {
      const existing = reviewIssues.find((i) => i.key === issue.key);
      if (existing) existing.transactionIds.push(...issue.transactionIds);
      else reviewIssues.push(issue);
    };
    const bills = await new BillService(this.db, this.guard).getBillsDueInMonth(
      userId,
      month,
      year,
      true,
    );
    const payments = bills.length
      ? await this.db
          .select({ row: transactions, brl: cashValueBrl })
          .from(transactions)
          .where(
            and(
              eq(transactions.userId, userId),
              eq(transactions.domainType, 'bill_payment'),
              eq(transactions.isPaid, true),
              eq(transactions.isReversed, false),
              isNull(transactions.reversesTransactionId),
              or(
                ...bills.map((b) =>
                  and(eq(transactions.billingMonth, b.month), eq(transactions.billingYear, b.year)),
                ),
              ),
            ),
          )
      : [];
    const foreignCardRows = bills.length
      ? await this.db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.userId, userId),
              ne(transactions.currency, 'BRL'),
              eq(transactions.isReversed, false),
              isNull(transactions.reversesTransactionId),
              or(ne(transactions.domainType, 'bill_payment'), isNull(transactions.domainType)),
              or(
                ...bills.map((b) =>
                  and(eq(transactions.billingMonth, b.month), eq(transactions.billingYear, b.year)),
                ),
              ),
            ),
          )
      : [];
    const occurrences = new Map<string, number>();
    for (const { row } of rows) {
      if (row.scheduledTransactionId && row.domainType === 'recurring_bill') {
        const key = `${row.scheduledTransactionId}:${row.date.toISOString()}`;
        occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
      }
    }
    for (const bill of bills) {
      if (bill.total === 0 && bill.paidTotal === 0 && bill.unpaidTotal === 0) continue;
      const key = `bill:${bill.cardId}:${bill.year}:${bill.month}`;
      const accountIds = userAccounts
        .filter((a) => a.id === bill.cardId || a.parentAccountId === bill.cardId)
        .map((a) => a.id);
      const detailHref = `/credit-cards/${bill.cardId}?month=${bill.month}&year=${bill.year}`;
      const foreign = foreignCardRows.filter(
        (r) =>
          accountIds.includes(r.destinationAccountId) &&
          r.billingMonth === bill.month &&
          r.billingYear === bill.year,
      );
      if (foreign.length) {
        review({
          key,
          name: bill.cardName,
          reason: 'missing_amount',
          transactionIds: foreign.map((r) => r.id),
          accountIds,
          detailHref,
        });
        continue;
      }
      const remaining = Money.fromNumber(Math.max(bill.unpaidTotal, 0), 'BRL');
      const confirmed = payments.filter(
        ({ row, brl }) =>
          accountIds.includes(row.destinationAccountId) &&
          row.billingMonth === bill.month &&
          row.billingYear === bill.year &&
          ['manual', 'bank'].includes(row.settlementSource) &&
          row.settlementDate !== null &&
          row.settlementDate <= new Date() &&
          brl !== null,
      );
      const confirmedCash = confirmed.length
        ? Money.sum(
            confirmed.map((p) => Money.fromString(p.brl ?? '0', 'BRL')),
            'BRL',
          ).toDbString()
        : null;
      add({
        key,
        statement: {
          billId: bill.billId,
          statementId: bill.statementId,
          dueDateSource: bill.dueDateSource,
        },
        ref: {
          kind: 'card_bill',
          parentAccountId: bill.cardId,
          billingMonth: bill.month,
          billingYear: bill.year,
        },
        name: bill.cardName,
        direction: 'payable',
        dueDate: bill.dueDate,
        currency: 'BRL',
        total: Money.fromNumber(bill.total, 'BRL').toDbString(),
        remaining: remaining.toDbString(),
        settledAmount: Money.fromNumber(bill.paidTotal, 'BRL').toDbString(),
        confirmedCash,
        status: !bill.dueDate
          ? 'needs_review'
          : remaining.isZero()
            ? 'settled'
            : bill.paidTotal > 0
              ? 'partial'
              : 'open',
        evidence:
          confirmedCash !== null
            ? confirmed.every((p) => p.row.settlementSource === 'bank')
              ? 'bank'
              : 'manual'
            : 'legacy',
        action: !bill.dueDate ? 'review' : remaining.isZero() ? 'view_details' : 'record_payment',
        accountIds,
        detailHref,
      });
      if (!bill.dueDate)
        review({
          key,
          name: bill.cardName,
          reason: 'unknown_cycle',
          transactionIds: [],
          accountIds,
          detailHref,
        });
    }
    for (const source of income.filter((s) => s.needsPayrollAllocation)) {
      const pending = source.occurrences.filter((o) => unresolvedIncomeIds.has(o.transactionId));
      if (!pending.length) continue;
      const key = `payroll-estimate-${source.accountId}`;
      const amount = source.pendingNetDepositBrl ?? '0.00';
      add({
        key,
        ref: { kind: 'other', transactionId: pending[0].transactionId },
        name: source.name,
        direction: 'receivable',
        dueDate: null,
        currency: 'BRL',
        total: amount,
        remaining: amount,
        settledAmount: '0.00',
        confirmedCash: null,
        status: 'needs_review',
        evidence: 'assumed',
        action: 'open_payroll',
        accountIds: [source.accountId],
        detailHref: '/income',
      });
      review({
        key,
        name: source.name,
        reason: source.pendingNetDepositBrl === null ? 'missing_amount' : 'payroll',
        transactionIds: pending.map((o) => o.transactionId),
        accountIds: [source.accountId],
        detailHref: '/income',
      });
    }
    for (const { row, brl } of rows) {
      const source = accountById.get(row.sourceAccountId);
      const destination = accountById.get(row.destinationAccountId);
      const ids = [row.sourceAccountId, row.destinationAccountId];
      const baseIssue = {
        name: row.description,
        transactionIds: [row.id],
        accountIds: ids,
        detailHref: `/transactions?month=${month}&year=${year}&view=details&accountId=${row.sourceAccountId}`,
      };
      if (
        row.scheduledTransactionId &&
        row.domainType === 'recurring_bill' &&
        (occurrences.get(`${row.scheduledTransactionId}:${row.date.toISOString()}`) ?? 0) > 1
      ) {
        review({
          ...baseIssue,
          key: `duplicate:${row.scheduledTransactionId}:${row.date.toISOString()}`,
          reason: 'duplicate_occurrence',
        });
        continue;
      }
      if (row.domainType === 'bill_payment') {
        if (!row.isPaid || row.settlementSource === 'legacy')
          review({
            ...baseIssue,
            key: `bill-payment:${row.destinationAccountId}:${row.billingYear ?? year}:${row.billingMonth ?? month}`,
            reason: 'legacy_bill_payment',
            detailHref: `/credit-cards/${destination?.parentAccountId ?? row.destinationAccountId}?month=${row.billingMonth ?? month}&year=${row.billingYear ?? year}`,
          });
        continue;
      }
      if (row.domainType?.startsWith('family_loan_')) continue;
      if (
        row.domainType?.startsWith('credit_card_') ||
        source?.type === 'credit_card' ||
        destination?.type === 'credit_card'
      ) {
        if (!row.domainType || row.billingMonth === null || row.billingYear === null)
          review({
            ...baseIssue,
            key: `card-row:${row.id}`,
            reason: row.domainType ? 'unknown_cycle' : 'unclassified_card_movement',
          });
        continue;
      }
      if (source?.type === 'checking' && destination?.type === 'checking') continue;
      if (unresolvedIncomeIds.has(row.id)) continue;
      const occ = incomeById.get(row.id);
      const isIncome = row.domainType?.startsWith('income_') ?? false;
      const payroll =
        row.domainType === 'loan_payment' &&
        loanById.get(row.destinationAccountId)?.paymentMethod === 'payroll';
      if (payroll && !row.isPaid) {
        review({
          ...baseIssue,
          key: `transaction:${row.id}`,
          reason: 'payroll',
          detailHref: '/income',
        });
        continue;
      }
      const paid = row.isPaid && row.settlementSource !== 'date_assumed';
      const amount = isIncome && !paid ? (occ?.amountBrl ?? brl) : brl;
      const needsReview = amount === null || (payroll && !paid) || !!occ?.needsPayrollAllocation;
      const direction = row.type === 'deposit' ? 'receivable' : 'payable';
      const ref: FinancialObligation['ref'] =
        row.domainType === 'recurring_bill'
          ? { kind: 'charge', transactionId: row.id }
          : row.domainType?.startsWith('loan_') && destination?.type === 'loan'
            ? {
                kind: 'loan_installment',
                transactionId: row.id,
                loanAccountId: row.destinationAccountId,
              }
            : isIncome
              ? { kind: 'income', transactionId: row.id }
              : { kind: 'other', transactionId: row.id };
      const total = Money.fromString(amount ?? '0', 'BRL').toDbString();
      const detailHref =
        ref.kind === 'charge'
          ? '/charges'
          : ref.kind === 'loan_installment'
            ? `/loans/${row.destinationAccountId}`
            : isIncome
              ? '/income'
              : baseIssue.detailHref;
      add({
        key: `transaction:${row.id}`,
        ref,
        name: row.description,
        direction,
        dueDate: row.date.toISOString().slice(0, 10),
        settledAt: row.settlementDate?.toISOString() ?? null,
        canUndo:
          paid &&
          !!row.settlementDate &&
          ['manual', 'bank'].includes(row.settlementSource) &&
          row.settlementDate >
            (accountById.get(row.paidFromAccountId ?? row.sourceAccountId)
              ?.openingBalanceAnchorAt ?? new Date(0)),
        oneTime: row.domainType === 'recurring_bill' && row.totalInstallments === 1,
        currency: 'BRL',
        total,
        remaining: paid ? '0.00' : total,
        settledAmount: paid ? total : '0.00',
        confirmedCash:
          paid && row.settlementSource !== 'legacy' && row.settlementDate && !payroll
            ? amount
            : null,
        status: needsReview ? 'needs_review' : paid ? 'settled' : 'open',
        evidence: row.settlementSource === 'date_assumed' ? 'assumed' : row.settlementSource,
        action:
          payroll || occ?.needsPayrollAllocation
            ? 'open_payroll'
            : needsReview
              ? 'review'
              : paid || ref.kind === 'other'
                ? 'view_details'
                : direction === 'receivable'
                  ? 'record_receipt'
                  : 'record_payment',
        accountIds: ids,
        detailHref,
      });
      const added = items.at(-1);
      if (added) added.revision = financialRevision(row);
      if (needsReview)
        review({
          ...baseIssue,
          key: `transaction:${row.id}`,
          reason: amount === null ? 'missing_amount' : 'payroll',
          detailHref,
        });
    }
    const family = new FamilyLoanFlowService(this.db, this.guard);
    for (const config of await family.list(userId)) {
      const ledger = await family.getLedger(userId, config.id, {
        currentPeriod: { month, year },
        forwardMonths: 0,
      });
      const period = ledger.months.find((m) => m.monthKey === prefix);
      if (!period || period.owed <= 0) continue;
      add({
        key: `family:${config.id}:${prefix}`,
        ref: {
          kind: 'family_receivable',
          configId: config.id,
          accountId: config.accountId,
          month,
          year,
        },
        name: config.personName,
        direction: 'receivable',
        dueDate: null,
        currency: 'BRL',
        total: Money.fromNumber(period.owed, 'BRL').toDbString(),
        remaining: Money.fromNumber(period.remaining, 'BRL').toDbString(),
        settledAmount: Money.fromNumber(period.paid, 'BRL').toDbString(),
        confirmedCash: null,
        status: period.remaining <= 0 ? 'settled' : period.paid > 0 ? 'partial' : 'open',
        evidence: 'legacy',
        action: period.remaining > 0 ? 'record_receipt' : 'view_details',
        accountIds: [config.accountId],
        detailHref: `/family-loans/${config.id}`,
      });
    }
    const filtered = items.filter(
      (i) => (!accountId || i.accountIds.includes(accountId)) && (!kind || i.ref.kind === kind),
    );
    const issues = reviewIssues.filter(
      (i) =>
        (!accountId || i.accountIds.includes(accountId)) &&
        (!kind ||
          (kind === 'card_bill' &&
            i.accountIds.some((id) => accountById.get(id)?.type === 'credit_card')) ||
          filtered.some((item) => item.key === i.key)),
    );
    const payable = filtered.filter(
      (i) => i.direction === 'payable' && (i.status === 'open' || i.status === 'partial'),
    );
    const receivable = filtered.filter(
      (i) => i.direction === 'receivable' && (i.status === 'open' || i.status === 'partial'),
    );
    const sum = (list: FinancialObligation[], field: 'remaining' | 'settledAmount') =>
      Money.sum(
        list.map((i) => Money.fromString(i[field], 'BRL')),
        'BRL',
      ).toDbString();
    return {
      month,
      year,
      items: filtered,
      reviewIssues: issues,
      summary: {
        payableCount: payable.length,
        receivableCount: receivable.length,
        reviewCount: issues.length,
        toPay: sum(payable, 'remaining'),
        toReceive: sum(receivable, 'remaining'),
        settledPayable: sum(
          filtered.filter((i) => i.direction === 'payable'),
          'settledAmount',
        ),
        settledReceivable: sum(
          filtered.filter((i) => i.direction === 'receivable'),
          'settledAmount',
        ),
      },
    };
  }
}
