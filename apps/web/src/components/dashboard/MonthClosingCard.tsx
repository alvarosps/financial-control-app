'use client';
import Link from 'next/link';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatCurrencyValue } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { cn } from '@/lib/utils';
import { MonthClosingChecklist } from './MonthClosingChecklist';
import { MonthPlanner } from './MonthPlanner';

type Props = {
  month: number;
  year: number;
};

const statusConfig = {
  open: {
    labelKey: 'monthClosing.statusOpen',
    variant: 'income',
  },
  review: {
    labelKey: 'monthClosing.statusReview',
    variant: 'warning',
  },
  closed: {
    labelKey: 'monthClosing.statusClosed',
    variant: 'secondary',
  },
} as const;

export function MonthClosingCard({ month, year }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [reopenDialogOpen, setReopenDialogOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');

  const utils = trpc.useUtils();

  const { data, isLoading, error, refetch } = trpc.dashboard.monthStatus.useQuery({
    month,
    year,
  });
  const overview = trpc.dashboard.monthOverview.useQuery({ month, year });

  const reopenMonth = trpc.dashboard.reopenMonth.useMutation({
    onSuccess: () => {
      toast.success(t('components-dashboard-monthclosingcard.monthReopenedSuccessfully'));
      setReopenDialogOpen(false);
      utils.dashboard.monthStatus.invalidate({ month, year });
      utils.dashboard.monthlySummary.invalidate({ month, year });
    },
    onError: (err) => {
      toast.error(err.message || t('common.reopenMonthFailed'));
    },
  });

  if (isLoading) return <SkeletonCard />;
  if (error) return <ErrorAlert message={error.message} onRetry={() => void refetch()} />;
  if (!data) return null;

  const status = data.status as 'open' | 'review' | 'closed';
  const config = statusConfig[status] ?? statusConfig.open;

  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <>
      <Card surface="solid">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t('components-dashboard-monthclosingcard.monthClosing')}
          </CardTitle>
          <Badge variant={config.variant} className="capitalize">
            {t(config.labelKey)}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm capitalize text-muted-foreground">{monthName}</p>

          {data.obligations && (
            <div className="flex flex-wrap gap-3 text-sm">
              {(['payable', 'receivable', 'review'] as const).map((key) => (
                <Link
                  className="underline"
                  key={key}
                  href={`/transactions?month=${month}&year=${year}&filter=${key}`}
                >
                  {t(`financial.${key}`)} (
                  {key === 'payable'
                    ? data.obligations.payableCount
                    : key === 'receivable'
                      ? data.obligations.receivableCount
                      : data.obligations.reviewCount}
                  )
                </Link>
              ))}
            </div>
          )}
          <Link className="text-sm underline" href="/accounts">
            {t('financial.adjustBalance')}
          </Link>
          {data.snapshot && (
            <div className="text-xs text-muted-foreground space-y-0.5">
              <p>
                {t('components-dashboard-monthclosingcard.income')}{' '}
                <span className="font-medium text-foreground">
                  {formatCurrencyValue(Number(data.snapshot.totalIncome))}
                </span>
              </p>
              <p>
                {t('monthClosing.expensesLabel')}{' '}
                <span className="font-medium text-foreground">
                  {formatCurrencyValue(Number(data.snapshot.totalExpenses))}
                </span>
              </p>
            </div>
          )}

          {overview.data?.payrollDateUncertain && (
            <p className="text-sm text-muted-foreground">{t('cashForecast.unknownDate')}</p>
          )}
          {overview.data && (
            <div className="grid grid-cols-3 gap-2 border-t pt-3 text-xs">
              <div className="space-y-0.5">
                <p className="text-muted-foreground">{t('financial.settled')}</p>
                <p className="font-medium font-numeric tabular-nums text-foreground">
                  {formatCurrencyValue(overview.data.paid.total)}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-muted-foreground">{t('monthClosing.toPayThisMonth')}</p>
                <p className="font-medium font-numeric tabular-nums text-foreground">
                  {formatCurrencyValue(overview.data.toPay.total)}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-muted-foreground">{t('monthClosing.walletBalance')}</p>
                <p
                  className={cn(
                    'font-medium font-numeric tabular-nums',
                    overview.data.walletBalance < 0 ? 'text-expense' : 'text-foreground',
                  )}
                >
                  {formatCurrencyValue(overview.data.walletBalance)}
                </p>
              </div>
            </div>
          )}

          {overview.data && (
            <MonthPlanner periods={overview.data.periods} cashToday={overview.data.cashToday} />
          )}

          <div className="flex gap-2 pt-1">
            {(status === 'open' || status === 'review') && (
              <Button size="sm" variant="default" onClick={() => setCloseDialogOpen(true)}>
                {t('components-dashboard-monthclosingcard.closeMonth')}
              </Button>
            )}
            {(status === 'closed' || status === 'review') && (
              <Button size="sm" variant="outline" onClick={() => setReopenDialogOpen(true)}>
                {t('components-dashboard-monthclosingcard.reopenMonth')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {!!data.history?.length && (
        <details className="rounded-md border p-3 text-sm">
          <summary>{t('closingChecklist.history')}</summary>
          <ol className="space-y-2 mt-2">
            {data.history.map((item) => (
              <li key={item.id}>
                {t('closingChecklist.version', {
                  revision: item.revision,
                  action: t(`closingChecklist.actions.${item.action}`),
                })}{' '}
                — {item.reason}
              </li>
            ))}
          </ol>
        </details>
      )}
      {/* Close Month Dialog */}
      <Dialog open={closeDialogOpen} onOpenChange={setCloseDialogOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('components-dashboard-monthclosingcard.closeMonth')}</DialogTitle>
            <DialogDescription className="first-letter:capitalize">
              {t('monthClosing.closeConfirmBody', { month: monthName })}
            </DialogDescription>
          </DialogHeader>
          <MonthClosingChecklist
            month={month}
            year={year}
            onClosed={() => setCloseDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Reopen Month Dialog */}
      <Dialog open={reopenDialogOpen} onOpenChange={setReopenDialogOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('components-dashboard-monthclosingcard.reopenMonth')}</DialogTitle>
            <DialogDescription className="first-letter:capitalize">
              {t('monthClosing.reopenConfirmBody', { month: monthName })}
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="reopen-reason">{t('closingChecklist.reopenReason')}</Label>
          <Input
            id="reopen-reason"
            maxLength={500}
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenDialogOpen(false)}>
              {t('components-dashboard-monthclosingcard.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                reopenMonth.mutate({
                  month,
                  year,
                  reason: reopenReason.trim(),
                  revision: data.revision,
                })
              }
              disabled={reopenMonth.isPending || reopenReason.trim().length < 3}
            >
              {reopenMonth.isPending
                ? t('monthClosing.reopening')
                : t('monthClosing.confirmReopen')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
