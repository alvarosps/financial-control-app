'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { CalendarClock, CalendarRange, Layers, Repeat } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { FilterTabs } from '@/components/shared/FilterTabs';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatCard } from '@/components/shared/StatCard';
import { Badge } from '@/components/ui/badge';
import { type ColumnDef, DataTable } from '@/components/ui/data-table';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatCurrency } from '@/lib/format';
import { getFrequencyLabel } from '@/lib/labels';
import { toDisplayNumber } from '@/lib/parse';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

type Scheduled = inferRouterOutputs<AppRouter>['scheduled']['list'] extends infer R
  ? R extends unknown[]
    ? R[number]
    : never
  : never;

type ScheduledFilter = 'all' | 'monthly' | 'installments' | 'once';

function isInstallment(s: Scheduled): boolean {
  return s.totalOccurrences != null;
}

function formatDate(date: Date | string, locale: string): string {
  return new Date(date).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function ScheduledClient() {
  const locale = useLocale();
  const t = useTranslations();
  usePageTitle(t('pageTitles.scheduled'));
  const [filter, setFilter] = useState<ScheduledFilter>('all');

  const { data: rawData, isLoading, error, refetch } = trpc.scheduled.list.useQuery();
  const schedules = toArray(rawData);

  const counts = useMemo(
    () => ({
      all: schedules.length,
      monthly: schedules.filter((s) => s.frequency === 'monthly').length,
      installments: schedules.filter(isInstallment).length,
      once: schedules.filter((s) => s.frequency === 'once').length,
    }),
    [schedules],
  );

  const monthlyCommitted = useMemo(
    () =>
      schedules
        .filter((s) => s.frequency === 'monthly')
        .reduce((sum, s) => sum + toDisplayNumber(s.amount), 0),
    [schedules],
  );

  const filtered = useMemo(() => {
    switch (filter) {
      case 'monthly':
        return schedules.filter((s) => s.frequency === 'monthly');
      case 'installments':
        return schedules.filter(isInstallment);
      case 'once':
        return schedules.filter((s) => s.frequency === 'once');
      default:
        return schedules;
    }
  }, [schedules, filter]);

  const columns: ColumnDef<Scheduled>[] = useMemo(
    () => [
      {
        accessorKey: 'description',
        header: t('scheduled.description'),
        cell: ({ row }) => {
          const s = row.original;
          return (
            <span>
              <span className="font-medium">{s.description}</span>
              {s.totalOccurrences != null && (
                <Badge variant="secondary" className="ml-2 align-middle">
                  {s.startingOccurrence}/{s.totalOccurrences}
                </Badge>
              )}
            </span>
          );
        },
      },
      {
        accessorKey: 'frequency',
        header: t('scheduled.frequency'),
        cell: ({ row }) => (
          <Badge variant="outline">{getFrequencyLabel(t, row.original.frequency)}</Badge>
        ),
      },
      {
        accessorKey: 'amount',
        header: () => <span className="block text-right">{t('scheduled.amount')}</span>,
        cell: ({ row }) => (
          <div className="text-right">
            <AmountDisplay amount={toDisplayNumber(row.original.amount)} size="sm" />
          </div>
        ),
        sortingFn: (a, b) =>
          toDisplayNumber(a.original.amount) - toDisplayNumber(b.original.amount),
      },
      {
        accessorKey: 'startDate',
        header: t('scheduled.nextDate'),
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {formatDate(row.original.startDate, locale)}
          </span>
        ),
        sortingFn: (a, b) =>
          new Date(a.original.startDate).getTime() - new Date(b.original.startDate).getTime(),
      },
      {
        id: 'status',
        header: t('scheduled.status'),
        enableSorting: false,
        cell: () => <Badge variant="income">{t('scheduled.active')}</Badge>,
      },
    ],
    [t, locale],
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t('scheduled.title')} subtitle={t('scheduled.subtitle')} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          tone="brand"
          label={t('scheduled.stats.totalActive')}
          value={counts.all}
          icon={<Repeat className="size-4" />}
        />
        <StatCard
          tone="expense"
          label={t('scheduled.stats.monthlyCommitted')}
          value={formatCurrency(monthlyCommitted)}
          icon={<CalendarRange className="size-4" />}
        />
        <StatCard
          tone="neutral"
          label={t('scheduled.stats.installments')}
          value={counts.installments}
          icon={<Layers className="size-4" />}
        />
      </div>

      {!isLoading && !error && schedules.length > 0 && (
        <FilterTabs
          tabs={[
            { key: 'all', label: t('scheduled.filters.all'), count: counts.all },
            { key: 'monthly', label: t('scheduled.filters.monthly'), count: counts.monthly },
            {
              key: 'installments',
              label: t('scheduled.filters.installments'),
              count: counts.installments,
            },
            { key: 'once', label: t('scheduled.filters.once'), count: counts.once },
          ]}
          value={filter}
          onValueChange={(key) => setFilter(key as ScheduledFilter)}
        />
      )}

      {isLoading && (
        <div className="space-y-3">
          {skeletonKeys(6).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      )}

      {error && <ErrorAlert message={error.message} onRetry={() => void refetch()} />}

      {!isLoading && !error && schedules.length === 0 && (
        <EmptyState
          icon={<CalendarClock className="h-12 w-12" />}
          title={t('scheduled.noScheduled')}
          description={t('scheduled.noScheduledDescription')}
        />
      )}

      {!isLoading && !error && schedules.length > 0 && (
        <DataTable columns={columns} data={filtered} emptyMessage={t('scheduled.noScheduled')} />
      )}
    </div>
  );
}
