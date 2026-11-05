import { Money } from '@fc/domain';
import { useMemo } from 'react';

type Schedule = {
  id: string;
  destinationAccountId: string;
  domainType: string | null;
  isActive: boolean;
  totalOccurrences: number | null;
  startingOccurrence: number | null;
  isFixedCharge: boolean | null;
  amount: string | number;
  startDate: string | Date;
};

export function useCardSchedules(schedules: Schedule[], cardId: string) {
  const installments = useMemo(
    () =>
      schedules.filter(
        (s) =>
          s.destinationAccountId === cardId &&
          s.domainType === 'credit_card_installment' &&
          s.isActive,
      ),
    [schedules, cardId],
  );

  const fixedCharges = useMemo(
    () =>
      schedules.filter(
        (s) =>
          s.destinationAccountId === cardId &&
          s.domainType === 'credit_card_fixed_charge' &&
          s.isActive,
      ),
    [schedules, cardId],
  );

  const monthlyExpenses = useMemo(
    () =>
      schedules.filter(
        (s) =>
          s.destinationAccountId === cardId &&
          s.isActive &&
          s.domainType !== 'credit_card_installment' &&
          s.domainType !== 'credit_card_fixed_charge' &&
          !s.totalOccurrences &&
          !s.isFixedCharge,
      ),
    [schedules, cardId],
  );

  // Total credit utilization = sum of all commitments on the card
  const totalUsed = useMemo(() => {
    const now = new Date();
    let totalMoney = Money.zero('BRL');
    for (const s of installments) {
      const totalOcc = s.totalOccurrences ?? 0;
      const startDate = new Date(s.startDate);
      const elapsed =
        (now.getFullYear() - startDate.getFullYear()) * 12 +
        (now.getMonth() - startDate.getMonth());
      const remaining = Math.max(totalOcc - elapsed, 0);
      totalMoney = totalMoney.add(Money.fromString(String(s.amount), 'BRL').multiply(remaining));
    }
    for (const s of fixedCharges) {
      totalMoney = totalMoney.add(Money.fromString(String(s.amount), 'BRL'));
    }
    for (const s of monthlyExpenses) {
      totalMoney = totalMoney.add(Money.fromString(String(s.amount), 'BRL'));
    }
    return totalMoney.toNumber();
  }, [installments, fixedCharges, monthlyExpenses]);

  return { installments, fixedCharges, monthlyExpenses, totalUsed };
}
