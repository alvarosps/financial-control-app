'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from 'recharts';
import { moneyTooltip } from '@/components/shared/chart-money-tooltip';
import { EmptyState } from '@/components/shared/EmptyState';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { type ChartConfig, ChartContainer } from '@/components/ui/chart';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { CHART_ANIMATION, ZERO_LINE } from '@/lib/chart-conventions';
import { formatCompactBRL } from '@/lib/format';
import { buildCompareSeries, type CompareScenario } from './scenario-compare-series';

type ScenarioCompareProps = {
  scenarios: CompareScenario[];
};

export function ScenarioCompare({ scenarios }: ScenarioCompareProps) {
  const t = useTranslations();
  const reducedMotion = usePrefersReducedMotion();
  const { rows, series } = useMemo(() => buildCompareSeries(scenarios), [scenarios]);

  const config = useMemo<ChartConfig>(() => {
    const c: ChartConfig = {};
    for (const s of series) c[s.id] = { label: s.name, color: s.color };
    return c;
  }, [series]);

  if (scenarios.length < 2) {
    return (
      <Card surface="solid">
        <CardContent>
          <EmptyState
            title={t('simulator.compare.emptyTitle')}
            description={t('simulator.compare.emptyHint')}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card surface="solid">
      <CardHeader>
        <CardTitle>{t('simulator.compare.title')}</CardTitle>
        <CardDescription>{t('simulator.compare.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {series.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: s.color }}
              />
              {s.name}
            </li>
          ))}
        </ul>
        <ChartContainer config={config} className="h-72 w-full">
          <LineChart data={rows} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
            <YAxis
              tickLine={false}
              axisLine={false}
              fontSize={11}
              width={56}
              tickFormatter={(v: number) => formatCompactBRL(v)}
            />
            <ReferenceLine y={0} {...ZERO_LINE} />
            {moneyTooltip(config)}
            {series.map((s) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={s.id}
                name={s.name}
                stroke={`var(--color-${s.id})`}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={!reducedMotion}
                {...CHART_ANIMATION}
              />
            ))}
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
