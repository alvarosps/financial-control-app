'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';

type ForecastMonth = inferRouterOutputs<AppRouter>['simulator']['run']['forecast'][number];

export function ForecastDisclosure({ months }: { months: ForecastMonth[] }) {
  const t = useTranslations();
  const sources = [
    ...new Map(
      months.flatMap((month) => month.sources).map((source) => [source.accountId, source]),
    ).values(),
  ];
  return (
    <Card>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('cashForecast.forecastWarning')}</p>
        {months.some((month) => month.incomeUnavailableCount > 0) && (
          <p role="status" className="text-sm text-expense">
            {t('cashForecast.incomplete')}
          </p>
        )}
        {months.some((month) => month.payrollDateUncertain) && (
          <p className="text-sm text-muted-foreground">{t('cashForecast.unknownDate')}</p>
        )}
        {sources
          .filter((source) => source.currency !== 'BRL')
          .map((source) => (
            <p key={source.accountId} className="text-xs text-muted-foreground">
              {source.name}:{' '}
              {t('cashForecast.configuredFx', {
                currency: source.currency,
                rate: source.configRate ?? t('cashForecast.unavailable'),
                fee: source.conversionFeePercent ?? '0',
                date: source.configUpdatedAt?.toLocaleDateString() ?? t('cashForecast.unavailable'),
              })}
            </p>
          ))}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="text-left font-medium mb-2">
              {t('cashForecast.familyAllocation')}
            </caption>
            <thead>
              <tr>
                {(['month', 'familyOwed', 'familyAllocated', 'familyRemaining'] as const).map(
                  (key) => (
                    <th key={key} scope="col" className="text-right p-2">
                      {t(`cashForecast.${key}`)}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {months.map((month) => (
                <tr key={`${month.year}-${month.month}`} className="border-t">
                  <th scope="row" className="text-right p-2">
                    {month.month}/{month.year}
                  </th>
                  {[month.familyOwed, month.familyAllocated, month.familyRemaining].map(
                    (amount, index) => (
                      <td
                        key={(['owed', 'allocated', 'remaining'] as const)[index]}
                        className="text-right p-2 font-numeric tabular-nums"
                      >
                        {formatCurrency(amount)}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
