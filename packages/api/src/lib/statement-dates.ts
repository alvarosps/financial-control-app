import { isCalendarDate } from '@fc/domain';
import type { StatementDateSource } from '@fc/shared';
import { TRPCError } from '@trpc/server';

export type StatementTransactionDates = {
  purchaseDate?: string | Date | null;
  postedDate?: string | Date | null;
  purchaseDateSource?: 'institution' | 'user';
  postedDateSource?: 'institution' | 'user';
};

function normalizeDate(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const date =
    value instanceof Date && Number.isFinite(value.getTime())
      ? value.toISOString().slice(0, 10)
      : value;
  if (typeof date !== 'string' || !isCalendarDate(date))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'statement.invalidDate' });
  return date;
}

export function statementTransactionDates(input: StatementTransactionDates): {
  purchaseDate: string | null;
  postedDate: string | null;
  purchaseDateSource: StatementDateSource;
  postedDateSource: StatementDateSource;
} {
  const purchaseDate = normalizeDate(input.purchaseDate);
  const postedDate = normalizeDate(input.postedDate);
  return {
    purchaseDate,
    postedDate,
    purchaseDateSource: purchaseDate ? (input.purchaseDateSource ?? 'user') : 'unknown',
    postedDateSource: postedDate ? (input.postedDateSource ?? 'user') : 'unknown',
  };
}
