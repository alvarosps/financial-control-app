import type { DbExecutor } from '@fc/db';
import { loanConfigs, payrollDeductions } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, or } from 'drizzle-orm';
import { FinancialPeriodGuard } from '../services/financial-period-guard.service.ts';

export function settlementDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

export async function assertOpenSettlementPeriods(db: DbExecutor, userId: string, dates: string[]) {
  return new FinancialPeriodGuard(db).assertOpen(userId, dates);
}

export async function assertNoPayrollAllocation(
  db: DbExecutor,
  userId: string,
  transactionId: string,
) {
  const [allocation] = await db
    .select({ id: payrollDeductions.id })
    .from(payrollDeductions)
    .where(
      and(
        eq(payrollDeductions.userId, userId),
        isNull(payrollDeductions.reversedAt),
        or(
          eq(payrollDeductions.incomeTransactionId, transactionId),
          eq(payrollDeductions.loanTransactionId, transactionId),
        ),
      ),
    );
  if (allocation)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Undo the payroll settlement before changing an allocated occurrence',
    });
}

export async function assertNotPayrollLoan(
  db: DbExecutor,
  destinationAccountId: string,
  domainType: string | null,
) {
  if (domainType !== 'loan_payment') return;
  const [config] = await db
    .select({ method: loanConfigs.paymentMethod })
    .from(loanConfigs)
    .where(eq(loanConfigs.accountId, destinationAccountId));
  if (config?.method === 'payroll')
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Payroll installments must be settled with an income occurrence',
    });
}
