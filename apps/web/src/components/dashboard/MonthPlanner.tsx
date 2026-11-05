'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { KindIcon } from '@/components/dashboard/KindIcon';
import { formatCurrencyValue, formatDueDate } from '@/lib/format';
import { cn } from '@/lib/utils';

type MonthOverview = inferRouterOutputs<AppRouter>['dashboard']['monthOverview'];
type PayPeriod = MonthOverview['periods'][number];
type PayPeriodBill = PayPeriod['bills'][number];

type Props = {
  periods: MonthOverview['periods'];
  cashToday: number;
};

/** Green when >= 0, red when < 0. */
function balanceColor(value: number): string {
  return value >= 0 ? 'text-income' : 'text-expense';
}

function billKey(bill: PayPeriodBill): string {
  return `${bill.kind}-${bill.id}-${bill.dueDate}`;
}

function periodKey(period: PayPeriod, index: number): string {
  return period.incomeDate ?? `before-${index}`;
}

export function MonthPlanner({ periods, cashToday }: Props) {
  const t = useTranslations();

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{t('monthClosing.planner')}</p>
        <p className="text-xs text-muted-foreground">
          {t('monthClosing.cashToday')}{' '}
          <span className={cn('font-medium font-numeric tabular-nums', balanceColor(cashToday))}>
            {formatCurrencyValue(cashToday)}
          </span>
        </p>
      </div>

      {periods.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2 text-center">
          {t('monthClosing.noPlanner')}
        </p>
      ) : (
        <div className="space-y-3">
          {periods.map((period, index) => (
            <div key={periodKey(period, index)} className="rounded-lg bg-muted/40 p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium truncate">
                  {period.incomeDate
                    ? period.incomeName
                      ? `${formatDueDate(period.incomeDate)} · ${period.incomeName}`
                      : formatDueDate(period.incomeDate)
                    : t('monthClosing.beforeFirstIncome')}
                </p>
                {period.incomeTotal > 0 && (
                  <span className="text-xs font-medium font-numeric tabular-nums text-income shrink-0">
                    +{formatCurrencyValue(period.incomeTotal)}
                  </span>
                )}
              </div>

              {period.bills.length > 0 && (
                <div className="space-y-1">
                  {period.bills.map((bill) => (
                    <div
                      key={billKey(bill)}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-muted-foreground w-9 shrink-0 font-numeric tabular-nums">
                          {formatDueDate(bill.dueDate)}
                        </span>
                        <KindIcon kind={bill.kind} className="size-3.5" />
                        <span className="truncate">{bill.name}</span>
                      </div>
                      <span className="font-numeric tabular-nums text-expense shrink-0">
                        {formatCurrencyValue(bill.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-1.5 text-xs">
                <span className="text-muted-foreground">
                  {t('monthClosing.saldoDoPeriodo')}{' '}
                  <span
                    className={cn(
                      'font-medium font-numeric tabular-nums',
                      balanceColor(period.saldoDoPeriodo),
                    )}
                  >
                    {formatCurrencyValue(period.saldoDoPeriodo)}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  {t('monthClosing.saldoCorrente')}{' '}
                  <span
                    className={cn(
                      'font-medium font-numeric tabular-nums',
                      balanceColor(period.saldoCorrente),
                    )}
                  >
                    {formatCurrencyValue(period.saldoCorrente)}
                  </span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
