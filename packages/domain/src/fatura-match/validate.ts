import Decimal from 'decimal.js';
import {
  isCalendarDate,
  resolveStatementCycle,
  type StatementCycle,
  StatementCycleError,
} from '../billing-period.ts';
import type { ParsedCard, ParsedItem } from './types.ts';

export class FaturaValidationError extends Error {
  constructor(
    readonly code: 'invalid_due_date',
    readonly dueDate: string,
  ) {
    super(`Vencimento inválido extraído da fatura: "${dueDate}"`);
    this.name = 'FaturaValidationError';
  }
}

export function resolveBillingFromDueDate(
  dueDate: string,
  config: { closingDay: number | null; dueDay: number | null; closingDate?: string | null },
): StatementCycle {
  if (!isCalendarDate(dueDate)) throw new FaturaValidationError('invalid_due_date', dueDate);
  const [year, month] = dueDate.split('-').map(Number);
  return resolveStatementCycle({
    reference: 'due',
    year,
    month,
    dueDate,
    closingDate: config.closingDate,
    config,
  });
}

export function validateStatementImportPeriod(input: {
  cycle: Pick<StatementCycle, 'billingMonth' | 'billingYear' | 'confidence'>;
  selectedPeriod: { month: number; year: number } | null;
  closed: boolean;
  today: string;
}): { future: boolean; estimated: boolean } {
  if (!input.selectedPeriod) throw new StatementCycleError('statement.periodReviewRequired');
  if (
    input.selectedPeriod.month !== input.cycle.billingMonth ||
    input.selectedPeriod.year !== input.cycle.billingYear
  )
    throw new StatementCycleError('statement.cycleConflict');
  if (input.closed) throw new StatementCycleError('statement.monthClosed');
  if (!isCalendarDate(input.today)) throw new StatementCycleError('statement.invalidDate');
  const cycleMonth = `${input.cycle.billingYear}-${String(input.cycle.billingMonth).padStart(2, '0')}`;
  return {
    future: cycleMonth > input.today.slice(0, 7),
    estimated: input.cycle.confidence !== 'confirmed',
  };
}

export function flattenParsedCards(cards: ParsedCard[]): ParsedItem[] {
  return cards.flatMap((card) =>
    card.items.map((item) => ({
      ...item,
      cardLastFour: card.lastFour,
      holderName: card.holderName,
      isAdditional: card.isAdditional,
    })),
  );
}

export function computeParsedTotals(items: ParsedItem[]): {
  chargesTotal: string;
  refundsTotal: string;
  netTotal: string;
} {
  let charges = new Decimal(0);
  let refunds = new Decimal(0);
  for (const item of items) {
    if (item.isRefund) refunds = refunds.plus(item.amountBRL);
    else charges = charges.plus(item.amountBRL);
  }
  return {
    chargesTotal: charges.toFixed(2),
    refundsTotal: refunds.toFixed(2),
    netTotal: charges.minus(refunds).toFixed(2),
  };
}

export function totalsDelta(netTotal: string, statedTotal: string | null): string | null {
  return statedTotal === null ? null : new Decimal(netTotal).minus(statedTotal).toFixed(2);
}
