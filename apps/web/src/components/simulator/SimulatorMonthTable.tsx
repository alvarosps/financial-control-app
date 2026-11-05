'use client';

import type { ProjectedMonth } from '@fc/domain';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { monthYearLabel } from '@/lib/labels';

export type SimulatorMonthTableProps = {
  baseline: ProjectedMonth[];
  simulated: ProjectedMonth[];
};

type View = 'baseline' | 'simulated';

export function SimulatorMonthTable({ baseline, simulated }: SimulatorMonthTableProps) {
  const locale = useLocale();
  const t = useTranslations();
  const [view, setView] = useState<View>('baseline');
  const rows = view === 'baseline' ? baseline : simulated;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {t('simulator.table.title')}
        </CardTitle>
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList>
            <TabsTrigger value="baseline">{t('simulator.table.viewBaseline')}</TabsTrigger>
            <TabsTrigger value="simulated">{t('simulator.table.viewSimulated')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('simulator.table.caption')}</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="text-left py-2 pr-4 font-medium">
                  {t('simulator.table.month')}
                </th>
                <th scope="col" className="text-right py-2 px-2 font-medium">
                  {t('simulator.table.opening')}
                </th>
                <th scope="col" className="text-right py-2 px-2 font-medium">
                  {t('cashForecast.economicIncome')}
                </th>
                {(
                  [
                    'familyRemaining',
                    'incomeHypothesis',
                    'contracted',
                    'expenseHypothesis',
                  ] as const
                ).map((key) => (
                  <th key={key} scope="col" className="text-right py-2 px-2 font-medium">
                    {t(`cashForecast.${key}`)}
                  </th>
                ))}
                <th scope="col" className="text-right py-2 px-2 font-medium">
                  {t('simulator.table.expenses')}
                </th>
                <th scope="col" className="text-right py-2 px-2 font-medium">
                  {t('simulator.table.net')}
                </th>
                <th scope="col" className="text-right py-2 pl-2 font-medium">
                  {t('simulator.table.ending')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const negative = m.endingBalance < 0;
                return (
                  <tr
                    key={`${m.year}-${m.month}`}
                    data-negative={negative ? 'true' : 'false'}
                    className={
                      negative ? 'border-b last:border-0 bg-expense/5' : 'border-b last:border-0'
                    }
                  >
                    <th scope="row" className="py-2 pr-4 font-medium text-left">
                      {monthYearLabel(m, 4, locale)}
                    </th>
                    <td className="text-right py-2 px-2">
                      <AmountDisplay amount={m.openingBalance} size="sm" showSign />
                    </td>
                    <td className="text-right py-2 px-2">
                      <AmountDisplay amount={m.income.base} size="sm" variant="income" />
                    </td>
                    {[
                      m.income.familyLoan,
                      m.income.lever,
                      m.expenses.total - m.expenses.lever,
                      m.expenses.lever,
                    ].map((amount, index) => (
                      <td
                        key={(['family', 'income', 'contracted', 'hypothesis'] as const)[index]}
                        className="text-right py-2 px-2"
                      >
                        <AmountDisplay amount={amount} size="sm" />
                      </td>
                    ))}
                    <td className="text-right py-2 px-2">
                      <AmountDisplay amount={m.expenses.total} size="sm" variant="expense" />
                    </td>
                    <td className="text-right py-2 px-2 font-semibold">
                      <AmountDisplay amount={m.net} size="sm" showSign />
                    </td>
                    <td className="text-right py-2 pl-2 font-semibold">
                      <AmountDisplay amount={m.endingBalance} size="sm" showSign />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
