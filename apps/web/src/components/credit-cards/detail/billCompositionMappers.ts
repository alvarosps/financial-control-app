import { Money } from '@fc/domain';

type BillTransaction = {
  id: string;
  description: string;
  amount: string | number;
  domainType: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  categoryId: string | null;
  scheduledTransactionId: string | null;
};

type Schedule = {
  id: string;
  totalOccurrences: number | null;
  startingOccurrence: number | null;
  categoryId: string | null;
  startDate?: string | Date | null;
};

type CompositionItem = {
  id: string;
  scheduledTransactionId?: string | null;
  description: string;
  amount: string;
  domainType: string | null;
  isActive: boolean;
  totalOccurrences: number | null;
  startingOccurrence: number | null;
  categoryId: string | null;
  isFixedCharge: boolean;
  canEdit: boolean;
  /** First-installment date of the schedule ≈ the purchase date (sort key). */
  startDate?: string | Date | null;
};

export function mapInstallments(
  transactions: BillTransaction[],
  schedules: Schedule[],
): CompositionItem[] {
  return transactions
    .filter((tx) => tx.domainType === 'credit_card_installment')
    .map((tx) => {
      const sched = schedules.find((s) => s.id === tx.scheduledTransactionId);
      return {
        id: tx.id,
        scheduledTransactionId: tx.scheduledTransactionId,
        description: tx.description,
        amount: String(tx.amount),
        domainType: tx.domainType,
        isActive: true,
        totalOccurrences: tx.totalInstallments ?? sched?.totalOccurrences ?? null,
        startingOccurrence: tx.installmentNumber ?? sched?.startingOccurrence ?? null,
        categoryId: tx.categoryId ?? sched?.categoryId ?? null,
        isFixedCharge: false,
        canEdit: !!sched,
        startDate: sched?.startDate ?? null,
      };
    });
}

export function mapFixedCharges(
  transactions: BillTransaction[],
  schedules: Schedule[],
): CompositionItem[] {
  return transactions
    .filter(
      (tx) =>
        tx.domainType === 'credit_card_fixed_charge' || tx.domainType === 'credit_card_annual_fee',
    )
    .map((tx) => {
      const sched = schedules.find((s) => s.id === tx.scheduledTransactionId);
      return {
        id: tx.id,
        scheduledTransactionId: tx.scheduledTransactionId,
        description: tx.description,
        amount: String(tx.amount),
        domainType: tx.domainType,
        isActive: true,
        totalOccurrences: null,
        startingOccurrence: null,
        categoryId: tx.categoryId ?? sched?.categoryId ?? null,
        isFixedCharge: true,
        canEdit: !!sched,
      };
    });
}

export function mapMonthlyExpenses(transactions: BillTransaction[]): CompositionItem[] {
  return transactions
    .filter(
      (tx) =>
        tx.domainType === 'credit_card_expense' ||
        (tx.domainType !== 'credit_card_installment' &&
          tx.domainType !== 'credit_card_fixed_charge' &&
          tx.domainType !== 'credit_card_annual_fee' &&
          tx.domainType !== 'credit_card_refund' &&
          tx.domainType !== 'bill_payment'),
    )
    .map((tx) => ({
      id: tx.id,
      scheduledTransactionId: tx.scheduledTransactionId,
      description: tx.description,
      amount: String(tx.amount),
      domainType: tx.domainType,
      isActive: true,
      totalOccurrences: null,
      startingOccurrence: null,
      categoryId: tx.categoryId ?? null,
      isFixedCharge: false,
      canEdit: !!tx.scheduledTransactionId || tx.domainType === 'credit_card_expense',
    }));
}

export function mapRefunds(transactions: BillTransaction[]) {
  return transactions
    .filter((tx) => tx.domainType === 'credit_card_refund')
    .map((tx) => ({
      id: tx.id,
      description: tx.description,
      amount: (() => {
        try {
          return Money.fromString(String(tx.amount), 'BRL').abs().toString();
        } catch {
          return '0.00';
        }
      })(),
    }));
}
