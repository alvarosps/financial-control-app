'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { CHART_COLORS } from '@/lib/constants';
import { formatCurrency } from '@/lib/format';

type SummaryData = inferRouterOutputs<AppRouter>['monthlySpending']['get']['summary'];

type Props = {
  summary: SummaryData;
};

const SEGMENTS = [
  {
    key: 'creditCards' as const,
    labelKey: 'spendingSummary.creditCards',
    color: CHART_COLORS.expense,
  },
  { key: 'grocery' as const, labelKey: 'spendingSummary.grocery', color: CHART_COLORS.grocery },
  {
    key: 'storeCards' as const,
    labelKey: 'spendingSummary.storeCards',
    color: CHART_COLORS.storeCards,
  },
  {
    key: 'marketplaceLoans' as const,
    labelKey: 'spendingSummary.marketplaceLoans',
    color: CHART_COLORS.marketplaceLoans,
  },
  { key: 'vehicle' as const, labelKey: 'spendingSummary.vehicle', color: CHART_COLORS.vehicle },
  { key: 'loans' as const, labelKey: 'spendingSummary.loans', color: CHART_COLORS.loans },
  {
    key: 'fixedExpenses' as const,
    labelKey: 'spendingSummary.fixedExpenses',
    color: CHART_COLORS.fixedExpenses,
  },
  { key: 'other' as const, labelKey: 'spendingSummary.other', color: CHART_COLORS.other },
];

export function SpendingSummary({ summary }: Props) {
  const t = useTranslations();
  // Money strings from the API; parseFloat only at the display boundary.
  const totalNum = Number.parseFloat(summary.total);
  const pieData = SEGMENTS.map((seg) => ({
    name: t(seg.labelKey),
    value: Number.parseFloat(summary.byType[seg.key].total),
    color: seg.color,
  })).filter((d) => d.value > 0);

  const hasData = pieData.length > 0;

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="mb-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('monthlySpending.summary.total')}
          </p>
          <p className="font-numeric text-3xl font-bold tabular-nums">{formatCurrency(totalNum)}</p>
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-8">
          <div className="relative mx-auto shrink-0" style={{ width: 160, height: 160 }}>
            {hasData ? (
              <div
                role="img"
                aria-label={t('spendingSummary.distributionAria', {
                  total: formatCurrency(totalNum),
                })}
              >
                <ResponsiveContainer width={160} height={160}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={54}
                      outerRadius={76}
                      dataKey="value"
                      strokeWidth={2}
                      paddingAngle={2}
                    >
                      {pieData.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center rounded-full border-4 border-muted">
                <span className="text-xs text-muted-foreground">{t('spendingSummary.noData')}</span>
              </div>
            )}
          </div>

          <div className="flex-1 space-y-1.5">
            {SEGMENTS.map((seg) => {
              const item = summary.byType[seg.key];
              const itemTotalNum = Number.parseFloat(item.total);
              const pct = totalNum > 0 ? ((itemTotalNum / totalNum) * 100).toFixed(1) : '0.0';
              return (
                <div key={seg.key} className="flex items-center justify-between gap-2 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: seg.color }}
                    />
                    <span className="truncate text-muted-foreground">{t(seg.labelKey)}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 font-numeric tabular-nums">
                    <span className="text-xs text-muted-foreground">{pct}%</span>
                    <span className="font-medium">{formatCurrency(itemTotalNum)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Card surface="glass" size="sm" className="gap-0 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">{t('spendingSummary.newInstallments')}</p>
            <p className="mt-0.5 font-numeric text-sm font-semibold text-expense tabular-nums">
              {formatCurrency(Number.parseFloat(summary.newInstallments.total))}
            </p>
            <p role="status" className="text-[10px] text-muted-foreground">
              {t('spendingSummary.itemsCount', { count: summary.newInstallments.count })}
            </p>
          </Card>
          <Card surface="glass" size="sm" className="gap-0 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              {t('monthlySpending.summary.oneOffExpenses')}
            </p>
            <p className="mt-0.5 font-numeric text-sm font-semibold text-spend-other tabular-nums">
              {formatCurrency(Number.parseFloat(summary.oneTimeExpenses.total))}
            </p>
            <p role="status" className="text-[10px] text-muted-foreground">
              {t('spendingSummary.itemsCount', { count: summary.oneTimeExpenses.count })}
            </p>
          </Card>
        </div>
      </CardContent>
    </Card>
  );
}
