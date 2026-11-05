import { useMemo } from 'react';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

export function useFamilyLoanData(configId: string, month: number, year: number) {
  const getById = trpc.familyLoan.getById.useQuery({ configId });
  const { data: monthly } = trpc.familyLoan.getMonthlyTotal.useQuery({ configId, month, year });
  const { data: projection } = trpc.familyLoan.get12MonthProjection.useQuery({
    configId,
    month,
    year,
  });
  const ledger = trpc.familyLoan.getLedger.useQuery({ configId, month, year });

  const { data: rawAccounts } = trpc.account.list.useQuery();
  const allAccounts = toArray(rawAccounts);
  const cardNameMap = useMemo(() => {
    const map = new Map<string, string>();
    allAccounts.forEach((a) => {
      map.set(a.id, a.name);
    });
    return map;
  }, [allAccounts]);

  const creditCardAccounts = useMemo(
    () => allAccounts.filter((a) => a.type === 'credit_card' && a.isActive),
    [allAccounts],
  );

  // Composition lists are sourced from the MONTH's transactions (monthly.items),
  // not the raw schedules: each item carries the real current parcela
  // (installmentNumber) and only the schedules with a current-month occurrence
  // appear (finished/not-yet-started series drop out naturally).
  const monthInstallments = monthly?.items?.installments ?? [];
  const monthFixedCharges = monthly?.items?.fixedCharges ?? [];
  const monthExpenses = monthly?.items?.expenses ?? [];
  const monthDiscounts = monthly?.items?.discounts ?? [];

  return {
    month,
    year,
    getById,
    monthly,
    projection,
    ledger: ledger.data,
    monthInstallments,
    monthFixedCharges,
    monthExpenses,
    monthDiscounts,
    cardNameMap,
    creditCardAccounts,
  };
}

export type FamilyLoanCompositionItem = {
  id: string;
  description: string;
  amount: string;
  installmentNumber: number | null;
  totalInstallments: number | null;
  scheduledTransactionId: string | null;
  domainType: string | null;
  isPaid: boolean;
};

export function useSortedFamilyLoanItems<T extends FamilyLoanCompositionItem>(
  items: T[] | undefined,
  search: string,
) {
  const sorted = useMemo(() => {
    if (!items) return [];
    return [...items].sort((a, b) => {
      // Sort by the CURRENT parcela (the value actually shown), highest first.
      const currentA = a.installmentNumber ?? 0;
      const currentB = b.installmentNumber ?? 0;
      if (currentB !== currentA) return currentB - currentA;
      const remainA = (a.totalInstallments ?? 999999) - currentA;
      const remainB = (b.totalInstallments ?? 999999) - currentB;
      return remainA - remainB;
    });
  }, [items]);

  const filtered = useMemo(() => {
    if (!search) return sorted;
    const term = search.toLowerCase();
    return sorted.filter((i) => i.description.toLowerCase().includes(term));
  }, [sorted, search]);

  return { sorted, filtered };
}
