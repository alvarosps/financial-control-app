'use client';

import { TrendingUp } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useLocale, useTranslations } from 'next-intl';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { ForecastDisclosure } from '@/components/shared/ForecastDisclosure';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatCard } from '@/components/shared/StatCard';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatCurrency } from '@/lib/format';
import { getMonthName } from '@/lib/labels';
import { trpc } from '@/lib/trpc/client';

const ProjectionChart = dynamic(
  () => import('./ProjectionChart').then((module) => module.ProjectionChart),
  {
    ssr: false,
    loading: () => <SkeletonCard />,
  },
);

export function ProjectionClient() {
  const locale = useLocale();
  const t = useTranslations();
  usePageTitle(t('pageTitles.projection'));
  const { data, isLoading, error } = trpc.projection.get12Months.useQuery();

  if (error) return <ErrorAlert message={error.message} />;

  const rows = data ?? [];
  const incomplete = rows.some((row) => row.forecast.incomeUnavailableCount > 0);
  const stabilizationIndex = rows.findIndex((row, index) => {
    if (index > rows.length - 3) return false;
    return row.balance > 0 && rows[index + 1]?.balance > 0 && rows[index + 2]?.balance > 0;
  });

  const currentMonthBalance = data?.[0]?.balance ?? 0;
  const accumulatedTotal =
    Math.round((data?.reduce((sum, d) => sum + d.balance, 0) ?? 0) * 100) / 100;
  const worstMonth = data?.reduce<(typeof data)[number] | null>(
    (worst, d) => (worst === null || d.balance < worst.balance ? d : worst),
    null,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('app-dashboard-projection-page.12MonthProjection')}
        subtitle={t('app-dashboard-projection-page.futureFinancialFlowOverview')}
      />

      {isLoading && (
        <div className="space-y-4">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {data && data.length === 0 && (
        <EmptyState
          icon={<TrendingUp className="h-12 w-12" />}
          title={t('app-dashboard-projection-page.noProjectionAvailable')}
          description={t('app-dashboard-projection-page.notEnoughDataTo')}
        />
      )}

      {data && data.length > 0 && (
        <>
          <ForecastDisclosure months={data.map((row) => row.forecast)} />
          {/* Summary */}
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              surface="glass"
              label={t('projection.currentMonthBalance')}
              value={formatCurrency(currentMonthBalance)}
              tone={currentMonthBalance >= 0 ? 'income' : 'expense'}
            />
            <StatCard
              surface="glass"
              label={t('projection.accumulatedTotal')}
              value={formatCurrency(accumulatedTotal)}
              tone={accumulatedTotal >= 0 ? 'income' : 'expense'}
            />
            <StatCard
              surface="glass"
              label={t('projection.worstMonth')}
              value={
                worstMonth
                  ? `${getMonthName(worstMonth.month, locale, 'short')}/${String(worstMonth.year).slice(2)}`
                  : '—'
              }
              tone="expense"
              delta={
                worstMonth
                  ? { label: formatCurrency(worstMonth.balance), direction: 'down' }
                  : undefined
              }
            />
          </div>

          <ProjectionChart data={data} />

          {/* Stabilization */}
          {!incomplete && stabilizationIndex >= 0 && data[stabilizationIndex] && (
            <Card surface="glass">
              <CardContent className="flex flex-wrap items-center gap-2 py-4">
                <Badge variant="income">{t('projection.stabilizationBadge')}</Badge>
                <p className="text-sm font-medium text-income">
                  {t('app-dashboard-projection-page.stabilizationStartingFrom')}{' '}
                  {getMonthName(data[stabilizationIndex].month, locale, 'short')}/
                  {data[stabilizationIndex].year} — {t('projection.stabilizationSuffix')}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Negative balance warning */}
          {data.every((d) => d.balance < 0) && (
            <Card surface="glass">
              <CardContent className="flex flex-wrap items-center gap-2 py-4">
                <Badge variant="expense">{t('projection.warningBadge')}</Badge>
                <p className="text-sm font-medium text-expense">
                  {t('app-dashboard-projection-page.warningEveryProjectedMonth')}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Detail table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('projection.monthlyBreakdown')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    {t('app-dashboard-projection-page.monthlyBreakdownOfFinancial')}
                  </caption>
                  <thead>
                    <tr className="border-b">
                      <th scope="col" className="text-left py-2 pr-4 font-medium">
                        {t('app-dashboard-projection-page.month')}
                      </th>
                      <th scope="col" className="text-right py-2 px-2 font-medium">
                        {t('cashForecast.economicIncome')}
                      </th>
                      <th
                        scope="col"
                        className="text-right py-2 px-2 font-medium hidden sm:table-cell"
                        title={t('app-dashboard-projection-page.personalCharges')}
                      >
                        {t('projection.personalCharges')}
                      </th>
                      <th scope="col" className="text-right py-2 px-2 font-medium">
                        {t('app-dashboard-projection-page.totalRevenue')}
                      </th>
                      <th scope="col" className="text-right py-2 px-2 font-medium">
                        {t('app-dashboard-projection-page.cards')}
                      </th>
                      <th
                        scope="col"
                        className="text-right py-2 px-2 font-medium hidden sm:table-cell"
                        title={t('app-dashboard-projection-page.loans')}
                      >
                        {t('app-dashboard-projection-page.loans')}
                      </th>
                      <th
                        scope="col"
                        className="text-right py-2 px-2 font-medium hidden sm:table-cell"
                      >
                        {t('projection.recurringCharges')}
                      </th>
                      <th scope="col" className="text-right py-2 px-2 font-medium">
                        {t('app-dashboard-projection-page.totalExpenses')}
                      </th>
                      <th scope="col" className="text-right py-2 px-2 font-medium">
                        {t('app-dashboard-projection-page.balance')}
                      </th>
                      <th scope="col" className="text-right py-2 px-2 font-medium">
                        {t('projection.accumulated')}
                      </th>
                      <th scope="col" className="text-center py-2 pl-2 font-medium">
                        {t('projection.status')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      let accumulated = 0;
                      return data.map((d) => {
                        accumulated += d.balance;
                        return (
                          <tr key={`${d.year}-${d.month}`} className="border-b last:border-0">
                            <th scope="row" className="py-2 pr-4 font-medium text-left">
                              {getMonthName(d.month, locale, 'short')}/{d.year}
                            </th>
                            <td className="text-right py-2 px-2">
                              <AmountDisplay amount={d.income} size="sm" variant="income" />
                            </td>
                            <td className="text-right py-2 px-2 hidden sm:table-cell">
                              <AmountDisplay
                                amount={d.familyLoanIncome}
                                size="sm"
                                variant="income"
                              />
                            </td>
                            <td className="text-right py-2 px-2 font-semibold">
                              <AmountDisplay amount={d.totalIncome} size="sm" variant="income" />
                            </td>
                            <td className="text-right py-2 px-2">
                              <AmountDisplay
                                amount={d.creditCardExpenses}
                                size="sm"
                                variant="expense"
                              />
                            </td>
                            <td className="text-right py-2 px-2 hidden sm:table-cell">
                              <AmountDisplay amount={d.loanExpenses} size="sm" variant="expense" />
                            </td>
                            <td className="text-right py-2 px-2 hidden sm:table-cell">
                              <AmountDisplay
                                amount={d.recurringExpenses}
                                size="sm"
                                variant="expense"
                              />
                            </td>
                            <td className="text-right py-2 px-2 font-semibold">
                              <AmountDisplay amount={d.totalExpenses} size="sm" variant="expense" />
                            </td>
                            <td className="text-right py-2 px-2">
                              <AmountDisplay amount={d.balance} size="sm" showSign />
                            </td>
                            <td className="text-right py-2 px-2 font-semibold">
                              <AmountDisplay
                                amount={Math.round(accumulated * 100) / 100}
                                size="sm"
                                showSign
                              />
                            </td>
                            <td className="text-center py-2 pl-2">
                              <Badge variant={d.isActual ? 'default' : 'secondary'} role="status">
                                {d.isActual ? t('projection.actual') : t('projection.projected')}
                              </Badge>
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
