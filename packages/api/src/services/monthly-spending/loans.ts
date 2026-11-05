import type { DbExecutor } from '@fc/db';
import { accounts, loanConfigs, scheduledTransactions } from '@fc/db';
import { Money } from '@fc/domain';
import { and, eq } from 'drizzle-orm';
import type { LoanItem } from './types.ts';

export async function getLoanSpending(
  db: DbExecutor,
  userId: string,
  month: number,
  year: number,
): Promise<LoanItem[]> {
  const rows = await db
    .select({
      scheduleId: scheduledTransactions.id,
      destinationAccountId: scheduledTransactions.destinationAccountId,
      startDate: scheduledTransactions.startDate,
      startingOccurrence: scheduledTransactions.startingOccurrence,
      totalOccurrences: scheduledTransactions.totalOccurrences,
      accountName: accounts.name,
      loanType: loanConfigs.loanType,
      totalInstallments: loanConfigs.totalInstallments,
      monthlyPayment: loanConfigs.monthlyPayment,
      originalAmount: loanConfigs.originalAmount,
      monthlyInterestRate: loanConfigs.monthlyInterestRate,
      annualInterestRate: loanConfigs.annualInterestRate,
    })
    .from(scheduledTransactions)
    .innerJoin(accounts, eq(accounts.id, scheduledTransactions.destinationAccountId))
    .innerJoin(loanConfigs, eq(loanConfigs.accountId, scheduledTransactions.destinationAccountId))
    .where(
      and(
        eq(scheduledTransactions.userId, userId),
        eq(scheduledTransactions.domainType, 'loan_payment'),
        eq(scheduledTransactions.isActive, true),
      ),
    );

  const result: LoanItem[] = [];

  for (const row of rows) {
    const startDate = row.startDate instanceof Date ? row.startDate : new Date(row.startDate);
    const startMonth = startDate.getMonth() + 1; // 1-based
    const startYear = startDate.getFullYear();

    const monthsDiff = (year - startYear) * 12 + (month - startMonth);
    const installmentNum = row.startingOccurrence + monthsDiff;

    if (installmentNum !== 1) continue;

    result.push({
      accountId: row.destinationAccountId,
      name: row.accountName,
      installmentNumber: installmentNum,
      totalInstallments: row.totalInstallments,
      loanType: row.loanType,
      monthlyPayment: Money.fromString(row.monthlyPayment, 'BRL').toDbString(),
      originalAmount:
        row.originalAmount !== null
          ? Money.fromString(row.originalAmount, 'BRL').toDbString()
          : '0.00',
      monthlyInterestRate: Number(row.monthlyInterestRate),
      annualInterestRate: row.annualInterestRate !== null ? Number(row.annualInterestRate) : 0,
    });
  }

  return result;
}
