'use client';

import type { ProjectedMonth } from '@fc/domain';
import { useLocale, useTranslations } from 'next-intl';
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartCard } from '@/components/shared/ChartCard';
import { moneyTooltip } from '@/components/shared/chart-money-tooltip';
import type { ChartConfig } from '@/components/ui/chart';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { defaultLocale } from '@/i18n/config';
import { CHART_ANIMATION, referenceBandProps, ZERO_LINE } from '@/lib/chart-conventions';
import { formatCompactBRL } from '@/lib/format';
import { monthYearLabel } from '@/lib/labels';

export type RunningBalanceChartProps = {
  baseline: ProjectedMonth[];
  simulated: ProjectedMonth[];
  /** Optional savings-goal target rendered as a dashed reference band. */
  targetLine?: { value: number; label: string };
};

export type RunningBalanceDatum = {
  name: string;
  baseline: number;
  simulated: number;
};

/**
 * Zip the baseline and simulated horizons into per-month chart rows. The
 * simulated horizon drives the X axis (it always has the same length as the
 * baseline); each row carries the month/year short label and both ending
 * balances. Exported so the data shape can be unit-tested without recharts
 * (which does not render in jsdom).
 */
export function buildRunningBalanceData(
  baseline: ProjectedMonth[],
  simulated: ProjectedMonth[],
  locale: string = defaultLocale,
): RunningBalanceDatum[] {
  return simulated.map((s, i) => ({
    // Compact 2-digit-year variant: the X axis is space-constrained.
    name: monthYearLabel(s, 2, locale),
    baseline: baseline[i]?.endingBalance ?? 0,
    simulated: s.endingBalance,
  }));
}

/**
 * Baseline-vs-simulated running balance over the projection horizon. Two
 * area series share the simulated horizon as the X axis; the conventional
 * y=0 line makes overdraft obvious, and an optional dashed band marks a
 * savings goal.
 */
export function RunningBalanceChart({ baseline, simulated, targetLine }: RunningBalanceChartProps) {
  const locale = useLocale();
  const t = useTranslations();
  const reducedMotion = usePrefersReducedMotion();

  const chartConfig = {
    baseline: { label: t('simulator.chart.baseline'), color: 'var(--color-muted-foreground)' },
    simulated: { label: t('simulator.chart.simulated'), color: 'var(--color-income)' },
  } satisfies ChartConfig;

  const chartData = buildRunningBalanceData(baseline, simulated, locale);

  return (
    <ChartCard
      title={t('simulator.chart.title')}
      config={chartConfig}
      surface="solid"
      bodyClassName="h-72"
    >
      <AreaChart data={chartData}>
        <defs>
          <linearGradient id="sim-baseline" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-baseline)" stopOpacity={0.25} />
            <stop offset="95%" stopColor="var(--color-baseline)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="sim-simulated" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-simulated)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-simulated)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis dataKey="name" className="text-xs" tick={{ fontSize: 11 }} />
        <YAxis
          className="text-xs"
          tick={{ fontSize: 11 }}
          width={56}
          tickFormatter={(v: number) => formatCompactBRL(v)}
        />
        {moneyTooltip(chartConfig)}
        <ReferenceLine y={0} {...ZERO_LINE} />
        {targetLine && (
          <ReferenceLine y={targetLine.value} {...referenceBandProps(targetLine.label)} />
        )}
        <Area
          type="monotone"
          dataKey="baseline"
          stroke="var(--color-baseline)"
          fill="url(#sim-baseline)"
          strokeWidth={2}
          name={t('simulator.chart.baseline')}
          isAnimationActive={!reducedMotion}
          {...CHART_ANIMATION}
        />
        <Area
          type="monotone"
          dataKey="simulated"
          stroke="var(--color-simulated)"
          fill="url(#sim-simulated)"
          strokeWidth={2}
          name={t('simulator.chart.simulated')}
          isAnimationActive={!reducedMotion}
          {...CHART_ANIMATION}
        />
      </AreaChart>
    </ChartCard>
  );
}
