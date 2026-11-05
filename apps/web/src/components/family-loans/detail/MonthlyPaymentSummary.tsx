'use client';

import type { AppRouter } from '@fc/api';
import { Money } from '@fc/domain';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { toDateInputValue } from '@/lib/dates';
import { formatCurrencyValue } from '@/lib/format';
import { getMonthName } from '@/lib/labels';
import { toDisplayNumber } from '@/lib/parse';

export type FamilyLoanLedger = inferRouterOutputs<AppRouter>['familyLoan']['getLedger'];

type Props = {
  ledger: FamilyLoanLedger;
  month: number;
  year: number;
};

function periodKey(month: number, year: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function formatMonthKey(value: string, locale: string): string {
  const [year, month] = value.split('-').map(Number);
  return `${getMonthName(month, locale)} ${year}`;
}

function formatPaymentDate(date: string | Date, locale: string): string {
  const value = toDateInputValue(date);
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, {
    timeZone: 'UTC',
  });
}

export function MonthlyPaymentSummary({ ledger, month, year }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const { months, totals, payments } = ledger;
  const currentKey = periodKey(month, year);
  const currentMonth = months.find((entry) => entry.monthKey === currentKey);
  const overdueMonths = months.filter((entry) => entry.status === 'overdue' && entry.remaining > 0);
  const currentMonthPayments = payments
    .filter((payment) => toDateInputValue(payment.date).startsWith(currentKey))
    .sort((left, right) => {
      const byDate = toDateInputValue(right.date).localeCompare(toDateInputValue(left.date));
      return byDate || left.id.localeCompare(right.id);
    });
  const currentMonthPaymentTotal = Money.sum(
    currentMonthPayments.map((payment) => Money.fromString(payment.amount, 'BRL')),
    'BRL',
  ).toNumber();

  return (
    <aside
      aria-label={t('components-family-loans-detail-paymentlistsection.monthSummary')}
      className="space-y-5 rounded-xl border border-glass-border bg-surface-elevated p-4 lg:col-span-1"
    >
      <h3 className="font-heading text-base font-medium leading-snug">
        {t('components-family-loans-detail-paymentlistsection.monthSummary')}
      </h3>

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('components-family-loans-detail-paymentlistsection.overdue')}
        </p>
        {overdueMonths.length === 0 ? (
          <Badge variant="income">
            {t('components-family-loans-detail-paymentlistsection.noOverdue')}
          </Badge>
        ) : (
          <>
            <p className="font-numeric text-lg font-bold tabular-nums text-expense">
              {formatCurrencyValue(totals.totalOverdue)}
            </p>
            <ul className="max-h-32 space-y-1 overflow-y-auto">
              {overdueMonths.map((entry) => (
                <li key={entry.monthKey} className="flex justify-between gap-2 text-xs">
                  <span className="capitalize">{formatMonthKey(entry.monthKey, locale)}</span>
                  <span className="font-numeric tabular-nums text-expense">
                    {formatCurrencyValue(entry.remaining)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="space-y-1 border-t border-glass-border pt-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('components-family-loans-detail-paymentlistsection.currentBalance')}
        </p>
        <p className="font-numeric text-lg font-bold tabular-nums">
          {formatCurrencyValue(currentMonth?.remaining ?? 0)}
        </p>
      </section>

      <section className="space-y-2 border-t border-glass-border pt-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('components-family-loans-detail-paymentlistsection.paymentsThisMonth')}
        </p>
        <p className="font-numeric text-lg font-bold tabular-nums text-income">
          {formatCurrencyValue(currentMonthPaymentTotal)}
        </p>
        {currentMonthPayments.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('components-family-loans-detail-paymentlistsection.noPaymentsThisMonth')}
          </p>
        ) : (
          <ul className="max-h-48 space-y-2 overflow-y-auto">
            {currentMonthPayments.map((payment) => (
              <li
                key={payment.id}
                className="rounded-lg border border-glass-border bg-glass-bg p-2"
              >
                <div className="flex justify-between gap-2">
                  <span className="truncate text-xs font-medium">
                    {payment.description ||
                      t('components-family-loans-detail-paymentlistsection.paymentFallback')}
                  </span>
                  <span className="font-numeric text-xs tabular-nums text-income">
                    {formatCurrencyValue(toDisplayNumber(payment.amount))}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {formatPaymentDate(payment.date, locale)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
