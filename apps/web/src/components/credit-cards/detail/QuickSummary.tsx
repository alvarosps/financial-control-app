// src/components/credit-cards/detail/QuickSummary.tsx

import { useLocale, useTranslations } from 'next-intl';
import { ProgressMeter } from '@/components/shared/ProgressMeter';
import { StatCard } from '@/components/shared/StatCard';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { getMonthName } from '@/lib/labels';
import { toDisplayNumber } from '@/lib/parse';

type Props = {
  closingDay: number;
  dueDay: number;
  /** Real calendar due date (YYYY-MM-DD). Null when the card has no config. */
  dueDate: string | null;
  dueDateSource?: 'institution' | 'user' | 'configuration' | 'unknown';
  creditLimit: string | null;
  currentBillTotal: number;
  totalUsed: number;
  previousBillTotal: number | null;
  currentBillMonth: number;
  currentBillYear: number;
};

function getBestPurchaseDay(closingDay: number, locale: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  // Clamp to last day of current month to avoid overflow
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
  const bestDayNum = Math.min(closingDay + 1, lastDayOfMonth);
  const bestDay = new Date(year, month, bestDayNum);
  return bestDay.toLocaleDateString(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function QuickSummary({
  closingDay,
  dueDate,
  dueDateSource,
  creditLimit,
  currentBillTotal,
  totalUsed,
  previousBillTotal,
  currentBillMonth,
  currentBillYear,
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const limitParsed = creditLimit ? toDisplayNumber(creditLimit) : null;
  const limit = limitParsed != null && !Number.isNaN(limitParsed) ? limitParsed : null;
  const available = limit ? limit - totalUsed : null;

  const billDelta = previousBillTotal != null ? currentBillTotal - previousBillTotal : null;
  const billDeltaLabel =
    billDelta != null
      ? `${billDelta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(billDelta))} ${t(
          'components-credit-cards-detail-quicksummary.previousBill',
        )}`
      : undefined;

  const dueDateDisplay = dueDate
    ? new Date(`${dueDate}T00:00:00`).toLocaleDateString(locale, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : t('statement.unknownDate');

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {/* Billing Cycle */}
      <div className="grid grid-cols-1 gap-4">
        <StatCard
          surface="glass"
          tone="expense"
          label={`${t('components-credit-cards-detail-quicksummary.currentBill')} · ${t('statement.competence', { period: `${getMonthName(currentBillMonth, locale, 'short')} ${currentBillYear}` })}`}
          value={formatCurrency(currentBillTotal)}
          delta={billDeltaLabel ? { label: billDeltaLabel, direction: 'neutral' } : undefined}
        />
        <StatCard
          surface="glass"
          tone="neutral"
          label={t('components-credit-cards-detail-quicksummary.dueDate')}
          value={`${dueDateDisplay}${dueDateSource === 'configuration' ? ` · ${t('statement.estimated')}` : ''}`}
          delta={{
            label: `${t('components-credit-cards-detail-quicksummary.bestPurchaseDay')} ${getBestPurchaseDay(
              closingDay,
              locale,
            )}`,
            direction: 'neutral',
          }}
        />
      </div>

      {/* Credit Limit */}
      <Card surface="glass">
        <CardContent className="pt-4 space-y-3">
          <h3 className="text-sm font-semibold">
            {t('components-credit-cards-detail-quicksummary.creditLimit')}
          </h3>
          {limit ? (
            <>
              <ProgressMeter
                current={toDisplayNumber(totalUsed)}
                total={toDisplayNumber(limit)}
                label={`${formatCurrency(totalUsed)} / ${formatCurrency(limit)}`}
              />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('components-credit-cards-detail-quicksummary.available')}
                </span>
                <span className="font-semibold text-income">
                  {available != null ? formatCurrency(available) : '—'}
                </span>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('components-credit-cards-detail-quicksummary.limitNotConfigured')}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
