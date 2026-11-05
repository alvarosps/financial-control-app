'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { Landmark } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { MarkPaidWalletDialog } from '@/components/shared/MarkPaidWalletDialog';
import { PayoffMeter } from '@/components/shared/PayoffMeter';
import { ProgressMeter } from '@/components/shared/ProgressMeter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { formatPercent } from '@/lib/format';
import { getLoanCategoryLabel, getLoanTypeLabel } from '@/lib/labels';
import { toDisplayNumber } from '@/lib/parse';
import { invalidateDashboard, trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

type LoanItem = inferRouterOutputs<AppRouter>['loan']['list'][number];

type Props = {
  item: LoanItem;
};

export function LoanCard({ item }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const { account, config } = item;

  const isCurrentMonthPaid = item.isCurrentMonthPaid;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [paidFromAccountId, setPaidFromAccountId] = useState('');
  const { data: walletData } = trpc.account.list.useQuery();
  const checkingAccounts = toArray(walletData)
    .filter((a) => a.type === 'checking' || a.type === 'savings')
    .map((a) => ({ id: a.id, name: a.name, isDefaultWallet: a.isDefaultWallet }));
  const { data: nextPayable } = trpc.loan.getNextPayable.useQuery(
    { accountId: account.id },
    { enabled: dialogOpen },
  );
  const utils = trpc.useUtils();
  const markPaid = trpc.loan.markCurrentAsPaid.useMutation({
    onMutate: async () => {
      await utils.loan.list.cancel();
      const prev = utils.loan.list.getData();
      utils.loan.list.setData(undefined, (old) =>
        old?.map((l) => {
          if (l.account.id !== account.id) return l;
          const nextOverdue = Math.max(0, l.overdueCount - 1);
          const nextIsCurrentMonthPaid = nextOverdue === 0;
          const nextIsPaidOff =
            l.config != null &&
            l.currentInstallment >= l.config.totalInstallments &&
            nextIsCurrentMonthPaid;
          return {
            ...l,
            overdueCount: nextOverdue,
            isCurrentMonthPaid: nextIsCurrentMonthPaid,
            isPaidOff: nextIsPaidOff,
          };
        }),
      );
      return { prev };
    },
    onError: (err, _vars, context) => {
      if (context?.prev) utils.loan.list.setData(undefined, context.prev);
      toast.error(err.message || t('loans.markPaidError'));
    },
    onSuccess: () => {
      toast.success(t('loans.markPaidSuccess'));
      setDialogOpen(false);
      setPaidFromAccountId('');
    },
    onSettled: () => {
      utils.loan.list.invalidate();
      utils.loan.getById.invalidate({ accountId: account.id });
      utils.loan.getPayoff.invalidate({ accountId: account.id });
      invalidateDashboard(utils);
      utils.account.list.invalidate();
    },
  });

  const { data: payoff } = trpc.loan.getPayoff.useQuery(
    { accountId: account.id },
    { enabled: config != null },
  );

  if (config == null) return null;

  const remaining = payoff?.remainingInstallments ?? config.totalInstallments;
  const paid = config.totalInstallments - remaining;
  const isPaidOff = item.isPaidOff;
  // Not started yet: the first installment is in a future month.
  const isFuture = item.currentInstallment <= 0;
  const firstInstallmentDate = config.startDate
    ? new Date(config.startDate).toLocaleDateString(locale, { timeZone: 'UTC' })
    : null;

  const monthlyPayment = toDisplayNumber(config.monthlyPayment);
  const insurance = config.insuranceAmount != null ? toDisplayNumber(config.insuranceAmount) : null;
  const totalMonthly = monthlyPayment + (insurance ?? 0);

  const showPayoff =
    config.payoffCalculationType != null && (payoff?.savingsPercent ?? 0) > 0 && payoff != null;

  return (
    <>
      <Link
        href={`/loans/${account.id}`}
        className="block motion-safe:transition-[transform,box-shadow] motion-safe:duration-200 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md"
      >
        <Card className="h-full">
          <CardHeader className="pb-0">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                  <Landmark className="size-4" />
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="truncate font-semibold">{account.name}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="brand">{getLoanCategoryLabel(t, config.loanCategory)}</Badge>
                    <Badge variant="outline">{getLoanTypeLabel(t, config.loanType)}</Badge>
                    {config?.paymentMethod === 'payroll' && (
                      <p className="text-xs text-muted-foreground">
                        {t('cashForecast.methods.payroll')} · {t('cashForecast.settleFromIncome')}
                      </p>
                    )}
                    {!isPaidOff &&
                      (isFuture ? (
                        <Badge variant="secondary">{t('loans.notStarted')}</Badge>
                      ) : (
                        <Badge variant={isCurrentMonthPaid ? 'income' : 'warning'}>
                          {isCurrentMonthPaid
                            ? t('loans.paidThisMonth')
                            : t('loans.pendingThisMonth')}
                        </Badge>
                      ))}
                  </div>
                </div>
              </div>
              {isPaidOff && <Badge variant="income">{t('loans.quitado')}</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <ProgressMeter
              current={paid}
              total={config.totalInstallments}
              label={`${t('loans.row.installment')} ${paid}/${config.totalInstallments}`}
            />

            <dl className="space-y-1.5 text-sm">
              {isFuture && firstInstallmentDate && (
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">{t('loans.row.firstInstallment')}</dt>
                  <dd className="font-numeric tabular-nums">{firstInstallmentDate}</dd>
                </div>
              )}
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t('loans.row.monthlyPayment')}</dt>
                <dd>
                  <AmountDisplay amount={monthlyPayment} variant="expense" size="sm" />
                </dd>
              </div>
              {insurance != null && (
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">{t('loans.row.insurance')}</dt>
                  <dd>
                    <AmountDisplay amount={insurance} variant="expense" size="sm" />
                  </dd>
                </div>
              )}
              <div className="flex items-center justify-between font-medium">
                <dt className="text-muted-foreground">{t('loans.row.totalMonthly')}</dt>
                <dd>
                  <AmountDisplay amount={totalMonthly} variant="expense" size="sm" />
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t('loans.row.dueDay')}</dt>
                <dd className="font-numeric tabular-nums">{config.dueDay}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t('loans.row.remaining')}</dt>
                <dd className="font-numeric tabular-nums">{remaining}</dd>
              </div>
            </dl>

            {showPayoff && (
              <PayoffMeter
                label={t('loans.payoff.title')}
                amount={
                  <AmountDisplay
                    amount={toDisplayNumber(payoff.outstandingBalance)}
                    variant="income"
                  />
                }
                savingsLabel={t('loans.payoff.savings')}
                savingsValue={formatPercent(payoff.savingsPercent)}
              />
            )}

            {!isPaidOff && !isCurrentMonthPaid && config?.paymentMethod !== 'payroll' && (
              <Button
                variant="brand"
                size="sm"
                className="w-full"
                disabled={markPaid.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const defaultWalletId =
                    checkingAccounts.find((a) => a.isDefaultWallet)?.id ??
                    checkingAccounts[0]?.id ??
                    '';
                  setPaidFromAccountId(defaultWalletId);
                  setDialogOpen(true);
                }}
              >
                {t('loans.markAsPaid')}
              </Button>
            )}
          </CardContent>
        </Card>
      </Link>

      <MarkPaidWalletDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        paidFromAccountId={paidFromAccountId}
        setPaidFromAccountId={setPaidFromAccountId}
        checkingAccounts={checkingAccounts}
        targetLabel={
          nextPayable
            ? t('loans.markPaidTarget', {
                n: nextPayable.installmentNumber ?? 0,
                total: nextPayable.totalInstallments ?? 0,
                date: new Date(`${nextPayable.date}T00:00:00Z`).toLocaleDateString(locale, {
                  timeZone: 'UTC',
                }),
              })
            : undefined
        }
        isPending={markPaid.isPending}
        onConfirm={() => markPaid.mutate({ accountId: account.id, paidFromAccountId })}
      />
    </>
  );
}
