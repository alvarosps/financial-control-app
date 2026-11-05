'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { CountUpAmount } from '@/components/shared/CountUpAmount';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { Card, CardContent } from '@/components/ui/card';
import { daysAgoSaoPauloISO } from '@/lib/dates';
import { formatCurrency } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { cn } from '@/lib/utils';

const CashSparkline = dynamic(
  () => import('./CashSparkline').then((module) => module.CashSparkline),
  { ssr: false, loading: () => <div className="h-16 w-44" aria-hidden="true" /> },
);

export type HeroCashPoint = { date: string; total: number };

export type HeroCashViewProps = {
  cashToday: number;
  deltaVs30d?: number;
  points: HeroCashPoint[];
};

export function getDeltaVs30d(cashToday: number, points: HeroCashPoint[]): number | undefined {
  const baseline = points[0];
  if (points.length < 2 || baseline?.date !== daysAgoSaoPauloISO(30)) return undefined;

  return cashToday - baseline.total;
}

/** Presentational hero for the canonical real-cash balance. */
export function HeroCashView({ cashToday, deltaVs30d, points }: HeroCashViewProps) {
  const t = useTranslations();

  return (
    <Card surface="glass">
      <CardContent className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('dashboard.hero.title')}
          </span>
          <CountUpAmount
            amount={cashToday}
            size="lg"
            variant={cashToday >= 0 ? 'income' : 'expense'}
            className="text-4xl"
          />
          {deltaVs30d !== undefined && (
            <span
              className={cn(
                'font-numeric text-xs font-medium tabular-nums',
                deltaVs30d >= 0 ? 'text-income' : 'text-expense',
              )}
            >
              {deltaVs30d >= 0 ? '+' : ''}
              {formatCurrency(deltaVs30d)} {t('dashboard.hero.deltaLabel')}
            </span>
          )}
        </div>
        {points.length > 1 && (
          <CashSparkline points={points} ariaLabel={t('dashboard.hero.sparklineAria')} />
        )}
      </CardContent>
    </Card>
  );
}

/** Fetches the canonical cash headline and its 30-day historical series. */
export function HeroCash({ month, year }: { month: number; year: number }) {
  const t = useTranslations();
  const overview = trpc.dashboard.monthOverview.useQuery({ month, year });
  const series = trpc.account.walletCashSeries.useQuery({ days: 30 });

  if (overview.isLoading) return <SkeletonCard />;
  if (overview.error) return <ErrorAlert message={overview.error.message} />;
  if (!overview.data) return null;

  const points = series.data ?? [];
  const deltaVs30d = getDeltaVs30d(overview.data.cashToday, points);

  return (
    <div className="space-y-2">
      <HeroCashView cashToday={overview.data.cashToday} deltaVs30d={deltaVs30d} points={points} />
      {overview.data.cashQuality?.some((wallet) => wallet.legacyMovementCount > 0) && (
        <p className="text-xs text-muted-foreground">{t('cashForecast.legacyCash')}</p>
      )}
      {overview.data.cashQuality?.some((wallet) => wallet.unresolvedMovementCount > 0) && (
        <p className="text-xs text-expense">{t('cashForecast.unresolvedCash')}</p>
      )}
    </div>
  );
}
