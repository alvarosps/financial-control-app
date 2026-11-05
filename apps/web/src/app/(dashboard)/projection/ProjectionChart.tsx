'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartCard } from '@/components/shared/ChartCard';
import { moneyTooltip } from '@/components/shared/chart-money-tooltip';
import type { ChartConfig } from '@/components/ui/chart';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { CHART_ANIMATION, ZERO_LINE } from '@/lib/chart-conventions';
import { formatCompactBRL } from '@/lib/format';
import { getMonthName } from '@/lib/labels';

type ProjectionRows = inferRouterOutputs<AppRouter>['projection']['get12Months'];

export function ProjectionChart({ data }: { data: ProjectionRows }) {
  const locale = useLocale();
  const t = useTranslations();
  const reducedMotion = usePrefersReducedMotion();
  const chartData = data.map((row) => ({
    name: `${getMonthName(row.month, locale, 'short')}/${String(row.year).slice(2)}`,
    income: row.totalIncome,
    expenses: row.totalExpenses,
  }));
  const chartConfig = {
    // Raw tokens (--income), NOT --color-income: ChartContainer emits a scoped
    // --color-<seriesKey>, so a series named "income" would self-reference the
    // global --color-income token and compute to invalid (black bars).
    income: { label: t('app-dashboard-projection-page.income'), color: 'var(--income)' },
    expenses: {
      label: t('app-dashboard-projection-page.totalExpenses'),
      color: 'var(--expense)',
    },
  } satisfies ChartConfig;

  return (
    <ChartCard
      title={t('projection.incomeVsExpenses')}
      config={chartConfig}
      surface="solid"
      bodyClassName="h-72"
    >
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis dataKey="name" className="text-xs" tick={{ fontSize: 11 }} />
        <YAxis
          className="text-xs"
          tick={{ fontSize: 11 }}
          width={56}
          tickFormatter={(value: number) => formatCompactBRL(value)}
        />
        {moneyTooltip(chartConfig)}
        <ReferenceLine y={0} {...ZERO_LINE} />
        <Bar
          dataKey="income"
          fill="var(--color-income)"
          name={t('app-dashboard-projection-page.income')}
          radius={[4, 4, 0, 0]}
          isAnimationActive={!reducedMotion}
          {...CHART_ANIMATION}
        />
        <Bar
          dataKey="expenses"
          fill="var(--color-expense)"
          name={t('app-dashboard-projection-page.totalExpenses')}
          radius={[4, 4, 0, 0]}
          isAnimationActive={!reducedMotion}
          {...CHART_ANIMATION}
        />
      </BarChart>
    </ChartCard>
  );
}
