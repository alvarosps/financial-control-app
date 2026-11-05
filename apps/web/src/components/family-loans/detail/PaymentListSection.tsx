'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toDateInputValue } from '@/lib/dates';
import { formatCurrencyValue } from '@/lib/format';
import { getMonthName } from '@/lib/labels';
import { toDisplayNumber } from '@/lib/parse';
import type { FamilyLoanLedger } from './MonthlyPaymentSummary';

type Ledger = FamilyLoanLedger;
type LedgerMonth = Ledger['months'][number];
export type ReversiblePayment = Ledger['payments'][number];
type LedgerStatus = LedgerMonth['status'];

type Props = {
  ledger: Ledger;
  onReversePayment: (payment: ReversiblePayment) => void;
  isReversing: boolean;
};

const STATUS_VARIANT: Record<
  LedgerStatus,
  'expense' | 'warning' | 'income' | 'secondary' | 'info'
> = {
  overdue: 'expense',
  partially_paid: 'warning',
  paid: 'income',
  open: 'secondary',
  credit: 'info',
};

const STATUS_KEY: Record<LedgerStatus, string> = {
  overdue: 'statusOverdue',
  partially_paid: 'statusPartial',
  paid: 'statusPaid',
  open: 'statusOpen',
  credit: 'statusCredit',
};

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

export function PaymentListSection({ ledger, onReversePayment, isReversing }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const { months, totals, payments } = ledger;

  return (
    <Card surface="glass">
      <CardContent className="space-y-5 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-base font-medium leading-snug">
              {t('components-family-loans-detail-paymentlistsection.ledgerTitle')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t('components-family-loans-detail-paymentlistsection.ledgerSubtitle')}
            </p>
          </div>
          <div className="flex gap-4">
            <div className="text-right">
              <p className="text-xs text-muted-foreground">
                {t('components-family-loans-detail-paymentlistsection.totalOutstanding')}
              </p>
              <p className="font-numeric text-base font-bold tabular-nums text-warning">
                {formatCurrencyValue(totals.totalOutstanding)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">
                {t('components-family-loans-detail-paymentlistsection.totalOverdue')}
              </p>
              <p className="font-numeric text-base font-bold tabular-nums text-expense">
                {formatCurrencyValue(totals.totalOverdue)}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          {months.length === 0 ? (
            <p className="rounded-lg border border-glass-border bg-glass-bg p-4 text-sm text-muted-foreground">
              {t('components-family-loans-detail-paymentlistsection.ledgerEmpty')}
            </p>
          ) : (
            <div className="space-y-1.5">
              <div className="hidden grid-cols-[1.5fr_1fr_1fr_1fr_auto] gap-3 px-3 text-xs text-muted-foreground sm:grid">
                <span>{t('components-family-loans-detail-paymentlistsection.colMonth')}</span>
                <span className="text-right">
                  {t('components-family-loans-detail-paymentlistsection.colOwed')}
                </span>
                <span className="text-right">
                  {t('components-family-loans-detail-paymentlistsection.colPaid')}
                </span>
                <span className="text-right">
                  {t('components-family-loans-detail-paymentlistsection.colRemaining')}
                </span>
                <span className="text-right">
                  {t('components-family-loans-detail-paymentlistsection.colStatus')}
                </span>
              </div>
              {months.map((entry) => (
                <div
                  key={entry.monthKey}
                  className="grid grid-cols-2 items-center gap-x-3 gap-y-1 rounded-lg border border-glass-border bg-glass-bg p-3 sm:grid-cols-[1.5fr_1fr_1fr_1fr_auto]"
                >
                  <span className="col-span-2 text-sm font-medium capitalize sm:col-span-1">
                    {formatMonthKey(entry.monthKey, locale)}
                  </span>
                  <span className="text-right font-numeric text-sm tabular-nums">
                    <span className="mr-1 text-xs text-muted-foreground sm:hidden">
                      {t('components-family-loans-detail-paymentlistsection.colOwed')}
                    </span>
                    {formatCurrencyValue(entry.owed)}
                  </span>
                  <span className="text-right font-numeric text-sm tabular-nums text-income">
                    <span className="mr-1 text-xs text-muted-foreground sm:hidden">
                      {t('components-family-loans-detail-paymentlistsection.colPaid')}
                    </span>
                    {formatCurrencyValue(entry.paid)}
                  </span>
                  <span className="text-right font-numeric text-sm tabular-nums">
                    <span className="mr-1 text-xs text-muted-foreground sm:hidden">
                      {t('components-family-loans-detail-paymentlistsection.colRemaining')}
                    </span>
                    {formatCurrencyValue(entry.remaining)}
                  </span>
                  <span className="col-span-2 flex sm:col-span-1 sm:justify-end">
                    <Badge variant={STATUS_VARIANT[entry.status]}>
                      {t(
                        `components-family-loans-detail-paymentlistsection.${STATUS_KEY[entry.status]}`,
                      )}
                    </Badge>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">
              {t('components-family-loans-detail-paymentlistsection.historyTitle')}
            </h3>
            {payments.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                {t('components-family-loans-detail-paymentlistsection.historyEmpty')}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {payments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-glass-border bg-glass-bg p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {payment.description ||
                          t('components-family-loans-detail-paymentlistsection.paymentFallback')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatPaymentDate(payment.date, locale)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-numeric text-sm font-bold tabular-nums text-income">
                        {formatCurrencyValue(toDisplayNumber(payment.amount))}
                      </span>
                      <Button
                        variant="destructive"
                        size="xs"
                        disabled={isReversing}
                        onClick={() => onReversePayment(payment)}
                      >
                        {t('components-family-loans-detail-paymentlistsection.reverse')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
