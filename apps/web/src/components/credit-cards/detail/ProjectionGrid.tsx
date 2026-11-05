import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { getMonthName } from '@/lib/labels';
import { safeParseFloat } from '@/lib/parse';
import { cn } from '@/lib/utils';

type ScheduledItem = {
  amount: string | number;
  totalOccurrences: number | null;
  startingOccurrence: number | null;
  isFixedCharge: boolean | null;
};

type Props = {
  installments: ScheduledItem[];
  fixedCharges: ScheduledItem[];
  monthlyExpenses: ScheduledItem[];
};

// Local calculation is intentional: this shows per-card projection using schedules
// already filtered for this specific card. trpc.projection.get12Months covers
// the full financial picture and is used by the projection page instead.
export function ProjectionGrid({ installments, fixedCharges, monthlyExpenses }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const now = new Date();
  const currentMonth = now.getMonth(); // 0-based

  const months = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const monthIdx = (currentMonth + i) % 12;

        // Fixed charges and monthly expenses: always apply
        const fixedTotal = fixedCharges.reduce(
          (s, fc) => s + Math.abs(safeParseFloat(fc.amount)),
          0,
        );
        const expenseTotal = monthlyExpenses.reduce(
          (s, e) => s + Math.abs(safeParseFloat(e.amount)),
          0,
        );

        // Installments: only if still active in this month
        const instTotal = installments.reduce((s, inst) => {
          if (!inst.totalOccurrences || !inst.startingOccurrence)
            return s + Math.abs(safeParseFloat(inst.amount));
          const remaining = inst.totalOccurrences - inst.startingOccurrence;
          return i < remaining ? s + Math.abs(safeParseFloat(inst.amount)) : s;
        }, 0);

        return {
          name: getMonthName(monthIdx + 1, locale),
          total: instTotal + fixedTotal + expenseTotal,
          isCurrent: i === 0,
        };
      }),
    [installments, fixedCharges, monthlyExpenses, currentMonth, locale],
  );

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <h2 className="text-base font-semibold">
          {t('components-credit-cards-detail-projectiongrid.12MonthProjection')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t('components-credit-cards-detail-projectiongrid.expectedMonthlyTotalsFor')}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {months.map((m) => (
            <div
              key={m.name}
              className={cn(
                'rounded-lg border p-3',
                m.isCurrent
                  ? 'border-primary/30 bg-primary/5'
                  : 'border-glass-border bg-surface-elevated',
              )}
            >
              <p className="text-xs text-muted-foreground">{m.name}</p>
              <p className="text-sm font-bold font-numeric tabular-nums">
                {formatCurrency(m.total)}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
