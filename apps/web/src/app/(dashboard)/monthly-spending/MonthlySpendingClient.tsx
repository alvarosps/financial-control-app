'use client';

import { keepPreviousData } from '@tanstack/react-query';
import { Car, Landmark as LandmarkIcon, Receipt, ShoppingCart, Store } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { CreditCardsSection } from '@/components/monthly-spending/CreditCardsSection';
import { FixedExpensesSection } from '@/components/monthly-spending/FixedExpensesSection';
import { LoansSection } from '@/components/monthly-spending/LoansSection';
import { OtherExpensesSection } from '@/components/monthly-spending/OtherExpensesSection';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { MonthNavigator } from '@/components/shared/MonthNavigator';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { useMonthNavigation } from '@/hooks/useMonthNavigation';
import { usePageTitle } from '@/hooks/usePageTitle';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';

const SpendingSummary = dynamic(
  () =>
    import('@/components/monthly-spending/SpendingSummary').then(
      (module) => module.SpendingSummary,
    ),
  { ssr: false, loading: () => <SkeletonCard /> },
);

export function MonthlySpendingClient({
  initialMonth,
  initialYear,
}: {
  initialMonth: number;
  initialYear: number;
}) {
  const t = useTranslations();
  usePageTitle(t('pageTitles.monthlySpending'));
  const { month, year, goToPreviousMonth, goToNextMonth } = useMonthNavigation(
    initialMonth,
    initialYear,
  );

  const { data, isPending, error } = trpc.monthlySpending.get.useQuery(
    { month, year },
    { placeholderData: keepPreviousData },
  );
  const showSkeleton = isPending && data === undefined;

  const isEmpty =
    data &&
    data.creditCards.length === 0 &&
    data.groceryCards.length === 0 &&
    data.storeCards.length === 0 &&
    data.marketplaceLoans.length === 0 &&
    data.vehicleCards.length === 0 &&
    data.loans.length === 0 &&
    data.fixedExpenses.length === 0 &&
    data.otherExpenses.length === 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title={t('monthlySpending.title')}
        subtitle={t('monthlySpending.subtitle')}
        actions={
          <MonthNavigator
            month={month}
            year={year}
            onPrev={goToPreviousMonth}
            onNext={goToNextMonth}
            buttonSize="icon-lg"
          />
        }
      />

      {/* Loading */}
      {showSkeleton && (
        <div className="space-y-4">
          {skeletonKeys(3).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      )}

      {/* Error */}
      {error && <ErrorAlert message={error.message} />}

      {/* Empty */}
      {isEmpty && (
        <EmptyState
          icon={<Receipt className="size-12" />}
          title={t('monthlySpending.emptyTitle')}
          description={t('monthlySpending.emptyDescription')}
        />
      )}

      {/* Content */}
      {data && !isEmpty && (
        <div className="space-y-4">
          <SpendingSummary summary={data.summary} />
          <CreditCardsSection cards={data.creditCards} />
          <CreditCardsSection
            cards={data.groceryCards}
            title={t('monthlySpending.sections.grocery')}
            icon={ShoppingCart}
            tone="grocery"
          />
          <CreditCardsSection
            cards={data.storeCards}
            title={t('monthlySpending.sections.storeCards')}
            icon={Store}
            tone="store"
          />
          <CreditCardsSection
            cards={data.marketplaceLoans}
            title={t('monthlySpending.sections.marketplaceLoans')}
            icon={LandmarkIcon}
            tone="marketplace"
          />
          <CreditCardsSection
            cards={data.vehicleCards}
            title={t('monthlySpending.sections.vehicle')}
            icon={Car}
            tone="vehicle"
          />
          <LoansSection loans={data.loans} />
          <FixedExpensesSection expenses={data.fixedExpenses} />
          <OtherExpensesSection expenses={data.otherExpenses} />
        </div>
      )}
    </div>
  );
}
