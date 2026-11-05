import type { DbExecutor } from '@fc/db';
import { Money } from '@fc/domain';
import type { FinancialObligation, SettlementSource } from '@fc/shared';
import { FinancialObligationsService } from './financial-obligations.service.ts';
import { MaterializationGuard } from './materialization-guard.service.ts';
export type DailyItem = {
  kind: 'card' | 'loan' | 'fixed_charge' | 'one_time_charge' | 'income' | 'other';
  id: string;
  key?: string;
  obligation?: FinancialObligation;
  name: string;
  date: string; // YYYY-MM-DD
  amount: number;
  direction: 'in' | 'out';
  isPaid: boolean;
  settlementSource?: SettlementSource | 'predicted';
  amountUnavailable?: boolean;
  dateUncertain?: boolean;
  informational?: boolean;
  economicAmount?: string;
  currency?: string;
  billId?: string | null;
  statementId?: string;
  billingMonth?: number;
  billingYear?: number;
  dueDateSource?: 'institution' | 'user' | 'configuration' | 'unknown';
};

export class DailyControlService {
  constructor(private db: DbExecutor) {}
  async getDailyControl(userId: string, month: number, year: number) {
    const result = await new FinancialObligationsService(
      this.db,
      new MaterializationGuard(this.db),
    ).listForDuePeriod(userId, month, year);
    const items: DailyItem[] = result.items.map((obligation) => {
      const ref = obligation.ref;
      const kind: DailyItem['kind'] =
        ref.kind === 'card_bill'
          ? 'card'
          : ref.kind === 'loan_installment'
            ? 'loan'
            : ref.kind === 'charge'
              ? obligation.oneTime
                ? 'one_time_charge'
                : 'fixed_charge'
              : ref.kind === 'income' || ref.kind === 'family_receivable'
                ? 'income'
                : 'other';
      const amount = Money.fromString(
        obligation.status === 'settled' ? obligation.total : obligation.remaining,
        'BRL',
      );
      return {
        kind,
        id: obligation.key.startsWith('payroll-estimate-')
          ? obligation.key
          : ref.kind === 'card_bill'
            ? ref.parentAccountId
            : ref.kind === 'family_receivable'
              ? ref.configId
              : ref.transactionId,
        key: obligation.key,
        obligation,
        ...obligation.statement,
        name: obligation.name,
        date: obligation.dueDate ?? '',
        amount: amount.abs().toNumber(),
        direction: amount.isNegative()
          ? 'in'
          : obligation.direction === 'receivable'
            ? 'in'
            : 'out',
        isPaid: obligation.status === 'settled',
        dateUncertain: obligation.dueDate === null,
        informational:
          obligation.status === 'needs_review' && !obligation.key.startsWith('payroll-estimate-'),
        settlementSource: obligation.key.startsWith('payroll-estimate-')
          ? 'predicted'
          : obligation.evidence === 'assumed'
            ? 'date_assumed'
            : obligation.evidence,
        currency: obligation.currency,
        ...(ref.kind === 'card_bill'
          ? { billingMonth: ref.billingMonth, billingYear: ref.billingYear }
          : {}),
        amountUnavailable: result.reviewIssues.some(
          (i) => i.key === obligation.key && i.reason === 'missing_amount',
        ),
      };
    });
    const byDate = new Map<string, DailyItem[]>();
    for (const item of items.filter((i) => !i.dateUncertain))
      byDate.set(item.date, [...(byDate.get(item.date) ?? []), item]);
    const sum = (direction: 'in' | 'out') =>
      Money.sum(
        items
          .filter((i) => i.direction === direction && !i.informational)
          .map((i) => Money.fromNumber(i.amount, 'BRL')),
        'BRL',
      );
    const incoming = sum('in'),
      outgoing = sum('out');
    return {
      month,
      year,
      days: [...byDate]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, items]) => ({ date, items })),
      undatedItems: items.filter((i) => i.dateUncertain),
      reviewIssues: result.reviewIssues,
      summary: {
        totalItems: items.length,
        paidCount: items.filter((i) => i.isPaid).length,
        pendingCount: result.summary.payableCount + result.summary.receivableCount,
        totalIn: incoming.toNumber(),
        totalOut: outgoing.toNumber(),
        balance: incoming.subtract(outgoing).toNumber(),
        unavailableCount: items.filter((i) => i.amountUnavailable).length,
        undatedCount: items.filter((i) => i.dateUncertain).length,
        ...result.summary,
      },
    };
  }
}
