import { randomUUID } from 'node:crypto';
import type { Database, DbExecutor } from '@fc/db';
import {
  accounts,
  incomeSourceConfigs,
  loanConfigs,
  payrollDeductions,
  transactions,
} from '@fc/db';
import { getDomainTypesByGroup, Money } from '@fc/domain';
import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { financialManifestHash } from './financial-repair.service.ts';

const period = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const payrollAuditScopeSchema = z
  .object({
    userId: z.guid(),
    loanAccountIds: z.array(z.guid()).min(1).max(100),
    fromPeriod: period,
    toPeriod: period,
  })
  .strict()
  .refine(
    (scope) =>
      scope.toPeriod >= scope.fromPeriod &&
      new Set(scope.loanAccountIds).size === scope.loanAccountIds.length,
  );
type PayrollAuditScope = z.infer<typeof payrollAuditScopeSchema>;

/** Private evidence packet, never an executable repair or automatic classification. */
export class PayrollRepairAuditService {
  constructor(private db: DbExecutor) {}

  async audit(input: PayrollAuditScope, fingerprint: string) {
    const scope = payrollAuditScopeSchema.parse(input);
    const target = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(fingerprint);
    const owned = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, scope.userId))
      .orderBy(accounts.id);
    if (
      scope.loanAccountIds.some(
        (id) => !owned.some((account) => account.id === id && account.type === 'loan'),
      )
    )
      throw new Error('REPAIR_ACCOUNT_SCOPE_INVALID');
    const configs = await this.db
      .select()
      .from(loanConfigs)
      .where(inArray(loanConfigs.accountId, scope.loanAccountIds))
      .orderBy(loanConfigs.id);
    const incomeAccounts = owned.filter((account) => account.type === 'revenue');
    const incomeConfigs = incomeAccounts.length
      ? await this.db
          .select()
          .from(incomeSourceConfigs)
          .where(
            inArray(
              incomeSourceConfigs.accountId,
              incomeAccounts.map((account) => account.id),
            ),
          )
          .orderBy(incomeSourceConfigs.id)
      : [];
    const from = new Date(`${scope.fromPeriod}-01T00:00:00Z`);
    const to = new Date(
      Date.UTC(Number(scope.toPeriod.slice(0, 4)), Number(scope.toPeriod.slice(5)), 0),
    );
    const occurrences = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, scope.userId),
          gte(transactions.date, from),
          lte(transactions.date, to),
          or(
            inArray(transactions.domainType, getDomainTypesByGroup('income')),
            and(
              eq(transactions.domainType, 'loan_payment'),
              inArray(transactions.destinationAccountId, scope.loanAccountIds),
            ),
          ),
        ),
      )
      .orderBy(transactions.id);
    const ids = occurrences.map((row) => row.id);
    const allocations = ids.length
      ? await this.db
          .select()
          .from(payrollDeductions)
          .where(
            and(
              eq(payrollDeductions.userId, scope.userId),
              or(
                inArray(payrollDeductions.incomeTransactionId, ids),
                inArray(payrollDeductions.loanTransactionId, ids),
              ),
            ),
          )
          .orderBy(payrollDeductions.id)
      : [];
    const relatedIds = [
      ...new Set(
        allocations.flatMap((allocation) => [
          allocation.incomeTransactionId,
          allocation.loanTransactionId,
        ]),
      ),
    ].filter((id) => !ids.includes(id));
    const relatedOccurrences = relatedIds.length
      ? await this.db
          .select()
          .from(transactions)
          .where(and(eq(transactions.userId, scope.userId), inArray(transactions.id, relatedIds)))
          .orderBy(transactions.id)
      : [];
    const active = occurrences.filter((row) => !row.isReversed && !row.reversesTransactionId);
    const economicTotals = [...new Set(active.map((row) => row.currency))]
      .sort()
      .map((currency) => ({
        currency,
        income: Money.sum(
          active
            .filter((row) => row.currency === currency && row.domainType !== 'loan_payment')
            .map((row) => Money.fromString(row.amount, currency)),
          currency,
        ).toDbString(),
        loans: Money.sum(
          active
            .filter((row) => row.currency === currency && row.domainType === 'loan_payment')
            .map((row) => Money.fromString(row.amount, currency)),
          currency,
        ).toDbString(),
      }));
    const snapshot = {
      wallets: owned.filter((account) => account.type === 'checking'),
      loans: scope.loanAccountIds.map((id) => {
        const account = owned.find((account) => account.id === id);
        if (!account) throw new Error('REPAIR_ACCOUNT_SCOPE_INVALID');
        return {
          account,
          config: configs.find((config) => config.accountId === id) ?? null,
          proposedPaymentMethod: null,
          proposedIncomeSourceAccountId: null,
          proposedIncomeTransactionId: null,
          proposedSettlementDate: null,
          requiresEvidence: true,
        };
      }),
      incomeSources: incomeAccounts.map((account) => ({
        account,
        config: incomeConfigs.find((config) => config.accountId === account.id) ?? null,
      })),
      occurrences,
      relatedOccurrences,
      allocations,
      economicTotals,
    };
    return {
      version: 1 as const,
      kind: 'payroll-diagnosis' as const,
      id: randomUUID(),
      target,
      createdAt: new Date().toISOString(),
      scope,
      status: 'evidence-required' as const,
      executable: false as const,
      cashReconciled: false as const,
      snapshotHash: financialManifestHash(snapshot),
      ...snapshot,
    };
  }
}

export async function auditPayrollIntegrity(
  db: Database,
  scope: PayrollAuditScope,
  target: string,
) {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${scope.userId}, true)`);
      return new PayrollRepairAuditService(tx).audit(scope, target);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
