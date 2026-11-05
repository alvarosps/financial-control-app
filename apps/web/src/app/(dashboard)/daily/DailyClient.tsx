'use client';

import { keepPreviousData } from '@tanstack/react-query';
import { CalendarCheck } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type * as React from 'react';
import { DailySummary } from '@/components/daily/DailySummary';
import { DayGroup } from '@/components/daily/DayGroup';
import { TransactionRow } from '@/components/daily/TransactionRow';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { MonthNavigator } from '@/components/shared/MonthNavigator';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { useMonthNavigation } from '@/hooks/useMonthNavigation';
import { usePageTitle } from '@/hooks/usePageTitle';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';

export function DailyClient({
  initialMonth,
  initialYear,
}: {
  initialMonth: number;
  initialYear: number;
}) {
  const t = useTranslations();
  usePageTitle(t('pageTitles.dailyControl'));
  const { month, year, goToPreviousMonth, goToNextMonth } = useMonthNavigation(
    initialMonth,
    initialYear,
  );

  const { data, isPending, isPlaceholderData, error, refetch } =
    trpc.dashboard.dailyControl.useQuery({ month, year }, { placeholderData: keepPreviousData });
  const showSkeleton = isPending && data === undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('daily.title')}
        subtitle={t('statement.dailySubtitle')}
        actions={
          <MonthNavigator
            month={month}
            year={year}
            onPrev={goToPreviousMonth}
            onNext={goToNextMonth}
          />
        }
      />

      {showSkeleton && (
        <div className="space-y-4">
          {skeletonKeys(3).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      )}

      {error && <ErrorAlert message={error.message} onRetry={() => void refetch()} />}

      {data && (
        <>
          <DailySummary summary={data.summary} />
          <Link
            className="underline"
            href={`/transactions?month=${month}&year=${year}&filter=review`}
          >
            {t('financial.review')} ({data.summary.reviewCount ?? 0})
          </Link>
          {(data.summary.unavailableCount ?? 0) > 0 && (
            <p role="status">{t('cashForecast.incomplete')}</p>
          )}
          {(data.undatedItems?.length ?? 0) > 0 && (
            <section className="space-y-2">
              <h2 className="font-heading text-base font-medium leading-snug">
                {t('cashForecast.undated')}
              </h2>
              <p className="text-sm text-muted-foreground">{t('financial.undatedHelp')}</p>
              {data.undatedItems.map((item) => (
                <TransactionRow
                  key={item.key ?? item.id}
                  item={item}
                  disabled={isPlaceholderData}
                />
              ))}
            </section>
          )}

          {data.days.length === 0 ? (
            <EmptyState
              icon={<CalendarCheck className="h-12 w-12" />}
              title={t('daily.noItems')}
              description={t('daily.noItemsDesc')}
            />
          ) : (
            <div className="space-y-6">
              {data.days.map((day, index) => (
                <div
                  key={day.date}
                  className="stagger-item"
                  style={{ '--stagger-index': Math.min(index, 8) } as React.CSSProperties}
                >
                  <DayGroup date={day.date} items={day.items} disabled={isPlaceholderData} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
