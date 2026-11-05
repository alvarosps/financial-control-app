'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartSkeleton } from '@/components/shared/ChartSkeleton';
import { moneyTooltip } from '@/components/shared/chart-money-tooltip';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type ChartConfig, ChartContainer } from '@/components/ui/chart';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { CHART_ANIMATION, referenceBandProps } from '@/lib/chart-conventions';
import { formatCompactBRL } from '@/lib/format';
import { getMonthName } from '@/lib/labels';
import { trpc } from '@/lib/trpc/client';

type CashFlowChartDatum = {
  name: string;
  income: number;
  expenses: number;
};

/** Display-only mean across months that received income. */
export function calculateAverageIncome(data: CashFlowChartDatum[]): number {
  const monthsWithIncome = data.filter((datum) => datum.income > 0);
  if (monthsWithIncome.length === 0) return 0;

  return monthsWithIncome.reduce((sum, datum) => sum + datum.income, 0) / monthsWithIncome.length;
}

export function CashFlowChart() {
  const locale = useLocale();
  const t = useTranslations();
  const reducedMotion = usePrefersReducedMotion();
  const { data, isLoading, error, refetch } = trpc.dashboard.cashFlow.useQuery({ months: 6 });

  if (isLoading) return <ChartSkeleton />;
  if (error) return <ErrorAlert message={error.message} onRetry={() => void refetch()} />;
  if (!data) return null;

  const chartData = data.map((d) => ({
    name: `${getMonthName(d.month, locale)}/${String(d.year).slice(2)}`,
    income: d.income,
    expenses: d.expenses,
  }));

  const avgIncome = calculateAverageIncome(chartData);

  const chartConfig = {
    // Raw tokens: a series key equal to a global --color-* token (income) makes
    // ChartContainer's scoped --color-income self-referential → invalid/black.
    income: { label: t('dashboard.income'), color: 'var(--income)' },
    expenses: { label: t('dashboard.expenses'), color: 'var(--expense)' },
  } satisfies ChartConfig;

  return (
    <Card surface="solid">
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {t('dashboard.cashFlow')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {chartData.every((d) => d.income === 0 && d.expenses === 0) ? (
          <p className="text-sm text-muted-foreground py-8 text-center">{t('dashboard.noData')}</p>
        ) : (
          <ChartContainer config={chartConfig} className="h-64 w-full">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="name" className="text-xs" tick={{ fontSize: 12 }} />
              <YAxis
                className="text-xs"
                tick={{ fontSize: 12 }}
                width={56}
                tickFormatter={(value: number) => formatCompactBRL(value)}
              />
              {moneyTooltip(chartConfig)}
              {avgIncome > 0 && (
                <ReferenceLine
                  y={avgIncome}
                  {...referenceBandProps(t('dashboard.avgIncomeBand'))}
                />
              )}
              <Bar
                dataKey="income"
                fill="var(--color-income)"
                name={t('dashboard.income')}
                radius={[4, 4, 0, 0]}
                isAnimationActive={!reducedMotion}
                {...CHART_ANIMATION}
              />
              <Bar
                dataKey="expenses"
                fill="var(--color-expense)"
                name={t('dashboard.expenses')}
                radius={[4, 4, 0, 0]}
                isAnimationActive={!reducedMotion}
                {...CHART_ANIMATION}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
