'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { getMonthName } from '@/lib/labels';
import { cn } from '@/lib/utils';

type Props = {
  remaining: number;
  totalMonthly: number;
};

export function LoanScheduleTable({ remaining, totalMonthly }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const now = new Date();

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <h2 className="text-lg font-semibold">
          {t('components-loans-detail-loanscheduletable.12MonthProjection')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t('components-loans-detail-loanscheduletable.expectedMonthlyPaymentsFor')}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {Array.from({ length: 12 }, (_, i) => {
            const monthIdx = (now.getMonth() + i) % 12;
            const yearOffset = Math.floor((now.getMonth() + i) / 12);
            const stillActive = i < remaining;

            return (
              <div
                key={`${now.getFullYear() + yearOffset}-${monthIdx}`}
                className={cn(
                  'rounded-lg border p-3',
                  i === 0
                    ? 'ring-1 ring-primary/30 bg-primary/[0.06]'
                    : 'border-glass-border bg-surface-elevated',
                  !stillActive && 'opacity-40',
                )}
              >
                <p className="text-xs text-muted-foreground">
                  {getMonthName(monthIdx + 1, locale)}
                </p>
                <p className="text-sm font-bold font-numeric tabular-nums">
                  {stillActive ? formatCurrency(totalMonthly) : formatCurrency(0)}
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
