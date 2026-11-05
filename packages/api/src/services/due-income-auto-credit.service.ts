import type { DbExecutor } from '@fc/db';
import {
  accounts,
  incomeSourceConfigs,
  monthClosings,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import { getDomainTypesByGroup, Money } from '@fc/domain';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { convertIncomeToBrl } from '../lib/fx.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { settlementDateKey } from '../lib/settlement-guards.ts';
import { AccountService } from './account.service.ts';
import { SettlementService } from './settlement.service.ts';

const INCOME_DOMAIN_TYPES = getDomainTypesByGroup('income');

type GuardLike = {
  ensureMaterialized: (userId: string, month: number, year: number) => Promise<void>;
};

export type AutoCreditedIncome = {
  transactionId: string;
  description: string;
  amount: number;
  walletName: string;
  date: string;
};

export type AutoCreditResult = { credited: AutoCreditedIncome[] };

type DueRow = {
  id: string;
  description: string;
  amount: string;
  currency: string;
  date: Date | string;
  scheduledTransactionId: string | null;
  destId: string;
  destType: string | null;
  destActive: boolean | null;
  destName: string | null;
  destCurrency: string | null;
  destAnchorAt: Date | null;
};

type TargetWallet = { id: string; name: string; currency: string | null; anchorAt: Date | null };

/** BRL → no override. Forex+valid → override. Forex+invalid → skip. */
type ForexResolution = { skip: boolean; amountOverrideBrl?: string };

/**
 * Idempotently settle every materialized income occurrence whose entry date is
 * on/before `asOf` and is still unpaid. Each occurrence is credited into its
 * own destination wallet when that account is an active checking account,
 * otherwise into the user's default wallet. Re-running is a no-op because
 * settled occurrences flip `is_paid=true`.
 *
 * Forex income is fail-safe: a row is only settled when a valid configured
 * exchange rate converts it to BRL. Without a valid rate the row is left
 * unpaid for manual handling — it is never credited in its source currency.
 */
export class DueIncomeAutoCreditService {
  constructor(
    private db: DbExecutor,
    private guard: GuardLike,
  ) {}

  async run(userId: string, asOf: Date = new Date()): Promise<AutoCreditResult> {
    const day = settlementDateKey(asOf);
    await this.guard.ensureMaterialized(userId, Number(day.slice(5, 7)), Number(day.slice(0, 4)));
    return runWithMaterializationLock(this.db, userId, ({ db }) =>
      new DueIncomeAutoCreditService(db, this.guard).creditEligible(userId, day),
    );
  }

  private async creditEligible(userId: string, day: string): Promise<AutoCreditResult> {
    const defaultWallet = await new AccountService(this.db).getDefaultWallet(userId);
    const closedMonths = new Set(
      (
        await this.db
          .select({ month: monthClosings.month, year: monthClosings.year })
          .from(monthClosings)
          .where(and(eq(monthClosings.userId, userId), eq(monthClosings.status, 'closed')))
      ).map((period) => `${period.year}-${String(period.month).padStart(2, '0')}`),
    );

    const due: DueRow[] = await this.db
      .select({
        id: transactions.id,
        description: transactions.description,
        amount: transactions.amount,
        currency: transactions.currency,
        date: transactions.date,
        scheduledTransactionId: transactions.scheduledTransactionId,
        destId: transactions.destinationAccountId,
        destType: accounts.type,
        destActive: accounts.isActive,
        destName: accounts.name,
        destCurrency: accounts.currency,
        destAnchorAt: accounts.openingBalanceAnchorAt,
      })
      .from(transactions)
      .innerJoin(
        incomeSourceConfigs,
        eq(incomeSourceConfigs.accountId, transactions.sourceAccountId),
      )
      .leftJoin(accounts, eq(accounts.id, transactions.destinationAccountId))
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.isPaid, false),
          eq(transactions.isReversed, false),
          eq(incomeSourceConfigs.autoCreditByDate, true),
          sql`NOT EXISTS (SELECT 1 FROM loan_configs lc JOIN accounts loan ON loan.id = lc.account_id WHERE loan.user_id = ${userId} AND loan.is_active = true AND lc.payment_method = 'payroll' AND (lc.income_source_account_id IS NULL OR lc.income_source_account_id = ${transactions.sourceAccountId}))`,
          lte(transactions.date, new Date(`${day}T00:00:00Z`)),
          inArray(transactions.domainType, INCOME_DOMAIN_TYPES),
        ),
      );

    const settlement = new SettlementService(this.db);
    const credited: AutoCreditedIncome[] = [];

    for (const row of due) {
      const target: TargetWallet | undefined =
        row.destType === 'checking' && row.destActive && row.destName
          ? {
              id: row.destId,
              name: row.destName,
              currency: row.destCurrency,
              anchorAt: row.destAnchorAt,
            }
          : defaultWallet
            ? {
                id: defaultWallet.id,
                name: defaultWallet.name,
                currency: defaultWallet.currency,
                anchorAt: defaultWallet.openingBalanceAnchorAt,
              }
            : undefined;
      if (!target || target.currency !== 'BRL') continue;
      const date =
        typeof row.date === 'string' ? row.date.slice(0, 10) : row.date.toISOString().slice(0, 10);
      const settlementDate = new Date(`${date}T00:00:00-03:00`);
      if (
        closedMonths.has(date.slice(0, 7)) ||
        (target.anchorAt && settlementDate <= target.anchorAt)
      )
        continue;

      const forex = await this.resolveForex(userId, row);
      if (forex.skip) continue;

      await settlement.settle(userId, {
        transactionId: row.id,
        walletAccountId: target.id,
        leg: 'destination',
        settlementSource: 'date_assumed',
        settlementDate,
        ...(forex.amountOverrideBrl !== undefined && {
          amountOverrideBrl: forex.amountOverrideBrl,
        }),
      });

      const displayAmount =
        forex.amountOverrideBrl !== undefined
          ? Money.fromString(forex.amountOverrideBrl, 'BRL')
          : Money.fromString(row.amount, row.currency);

      credited.push({
        transactionId: row.id,
        description: row.description,
        amount: displayAmount.toNumber(),
        walletName: target.name,
        date,
      });
    }

    return { credited };
  }

  /**
   * Decide whether a row can be settled and, for forex income, the BRL override.
   * Reuses the canonical `convertIncomeToBrl` (which validates the rate and
   * throws on an invalid one, and applies the source's conversion fee so the
   * stored BRL override is net) so the fail-safe rule lives in a single place.
   */
  private async resolveForex(userId: string, row: DueRow): Promise<ForexResolution> {
    if (row.currency === 'BRL') return { skip: false };
    if (!row.scheduledTransactionId) return { skip: true };

    const [cfg] = await this.db
      .select({
        rate: incomeSourceConfigs.exchangeRate,
        feePercent: incomeSourceConfigs.conversionFeePercent,
      })
      .from(scheduledTransactions)
      .innerJoin(
        incomeSourceConfigs,
        eq(incomeSourceConfigs.id, scheduledTransactions.domainConfigId),
      )
      .where(
        and(
          eq(scheduledTransactions.id, row.scheduledTransactionId),
          eq(scheduledTransactions.userId, userId),
        ),
      );

    try {
      const brl = convertIncomeToBrl(
        Money.fromString(row.amount, row.currency),
        row.currency,
        null,
        cfg?.rate,
        cfg?.feePercent,
      );
      return { skip: false, amountOverrideBrl: brl.toDbString() };
    } catch {
      return { skip: true };
    }
  }
}
