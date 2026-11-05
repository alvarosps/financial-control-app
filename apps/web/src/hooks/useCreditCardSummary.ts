import { useLocale } from 'next-intl';
import { useMemo } from 'react';
import { getMonthName } from '@/lib/labels';
import { safeParseFloat } from '@/lib/parse';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

export function useCreditCardSummary() {
  const locale = useLocale();
  const billSummaryQuery = trpc.creditCard.getBillSummary.useQuery();
  const accountsQuery = trpc.account.list.useQuery();
  const schedulesQuery = trpc.scheduled.list.useQuery();
  const configsQuery = trpc.creditCard.listConfigs.useQuery();

  const { data: billSummary, isLoading: billsLoading } = billSummaryQuery;
  const { data: rawAccounts, isLoading: accountsLoading } = accountsQuery;
  const { data: rawSchedules, isLoading: schedulesLoading } = schedulesQuery;
  const { data: configs } = configsQuery;
  const allAccounts = toArray(rawAccounts);
  const schedules = toArray(rawSchedules);

  const isLoading = billsLoading || accountsLoading || schedulesLoading;

  const configMap = useMemo(() => {
    const map = new Map<
      string,
      { closingDay: number; dueDay: number; creditLimit: string | null }
    >();
    configs?.forEach((c) => {
      map.set(c.accountId, {
        closingDay: c.closingDay,
        dueDay: c.dueDay,
        creditLimit: c.creditLimit,
      });
    });
    return map;
  }, [configs]);

  const cards = useMemo(() => {
    if (!billSummary || allAccounts.length === 0 || schedules.length === 0) return [];

    return [...billSummary]
      .sort((a, b) => {
        const configA = configMap.get(a.cardId);
        const configB = configMap.get(b.cardId);
        const dueDayA = configA?.dueDay ?? 99;
        const dueDayB = configB?.dueDay ?? 99;
        if (dueDayA !== dueDayB) return dueDayA - dueDayB;
        return a.cardName.localeCompare(b.cardName, locale);
      })
      .map((bill) => {
        const account = allAccounts.find((a) => a.id === bill.cardId);
        const config = configMap.get(bill.cardId);

        const installmentCount = schedules.filter(
          (s) =>
            s.destinationAccountId === bill.cardId &&
            s.domainType === 'credit_card_installment' &&
            s.isActive,
        ).length;

        const isAdditional = account?.parentAccountId != null;
        const rawCreditLimit = config?.creditLimit ? safeParseFloat(config.creditLimit) : null;
        const creditLimit = rawCreditLimit != null && rawCreditLimit > 0 ? rawCreditLimit : null;

        const cardIdsForLimit = [bill.cardId];
        if (!isAdditional) {
          const additionalIds = allAccounts
            .filter((a) => a.parentAccountId === bill.cardId && a.isActive)
            .map((a) => a.id);
          cardIdsForLimit.push(...additionalIds);
        }

        const now = new Date();
        let used = 0;
        for (const cid of cardIdsForLimit) {
          const cSchedules = schedules.filter((s) => s.destinationAccountId === cid && s.isActive);

          // Installments: amount × remaining occurrences
          used += cSchedules
            .filter((s) => s.domainType === 'credit_card_installment' && s.totalOccurrences != null)
            .reduce((sum, s) => {
              const startDate = new Date(s.startDate);
              const elapsed =
                (now.getFullYear() - startDate.getFullYear()) * 12 +
                (now.getMonth() - startDate.getMonth());
              const remaining = Math.max((s.totalOccurrences ?? 0) - elapsed, 0);
              return sum + safeParseFloat(s.amount) * remaining;
            }, 0);

          // Fixed charges: counted once
          used += cSchedules
            .filter((s) => s.domainType === 'credit_card_fixed_charge')
            .reduce((sum, s) => sum + safeParseFloat(s.amount), 0);

          // Monthly expenses: counted once
          used += cSchedules
            .filter(
              (s) =>
                s.domainType !== 'credit_card_installment' &&
                s.domainType !== 'credit_card_fixed_charge' &&
                !s.totalOccurrences &&
                !s.isFixedCharge,
            )
            .reduce((sum, s) => sum + safeParseFloat(s.amount), 0);
        }

        const available = creditLimit != null ? creditLimit - used : null;

        return {
          ...bill,
          account,
          config,
          installmentCount,
          isAdditional,
          creditLimit,
          used,
          available,
        };
      });
  }, [billSummary, allAccounts, schedules, configMap, locale]);

  const monthlySummary = useMemo(() => {
    if (!billSummary || cards.length === 0) return null;

    const now = new Date();
    const calendarMonth = now.getMonth() + 1;
    const calendarYear = now.getFullYear();

    let totalMonth = 0;
    let paidAmount = 0;
    let paidCards = 0;
    let pendingCards = 0;
    let totalLimit = 0;
    let totalUsed = 0;
    let hasLimit = false;

    for (const card of cards) {
      // Floor at 0: a credit (negative) bill owes nothing, so it must not add
      // its absolute value to the month's "total to pay".
      if (card.currentBill.month === calendarMonth && card.currentBill.year === calendarYear) {
        totalMonth += Math.max(0, card.currentBill.total);
        if (card.currentBill.isPaid) {
          paidAmount += Math.max(0, card.currentBill.total);
          paidCards++;
        } else {
          pendingCards++;
        }
      } else if (
        card.previousBill?.month === calendarMonth &&
        card.previousBill?.year === calendarYear
      ) {
        totalMonth += Math.max(0, card.previousBill.total);
        if (card.previousBill.isPaid) {
          paidAmount += Math.max(0, card.previousBill.total);
          paidCards++;
        } else {
          pendingCards++;
        }
      }

      if (card.creditLimit != null) {
        hasLimit = true;
        totalLimit += card.creditLimit;
        totalUsed += card.used;
      }
    }

    const totalAvailable = totalLimit - totalUsed;
    const paidPct = totalMonth > 0 ? (paidAmount / totalMonth) * 100 : 0;
    const limitPct = totalLimit > 0 ? (totalUsed / totalLimit) * 100 : 0;

    return {
      calendarMonth,
      calendarMonthLabel: getMonthName(calendarMonth, locale, 'short'),
      totalMonth,
      paidAmount,
      unpaidAmount: totalMonth - paidAmount,
      paidCards,
      pendingCards,
      totalCards: paidCards + pendingCards,
      paidPct,
      totalLimit: hasLimit ? totalLimit : null,
      totalAvailable: hasLimit ? totalAvailable : null,
      totalUsed: hasLimit ? totalUsed : null,
      limitPct: hasLimit ? limitPct : null,
    };
  }, [billSummary, cards, locale]);

  return {
    cards,
    monthlySummary,
    isLoading,
    isError:
      billSummaryQuery.isError ||
      accountsQuery.isError ||
      schedulesQuery.isError ||
      configsQuery.isError,
  };
}
