'use client';

import { Money } from '@fc/domain';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { AddIncomeSourceDialog } from '@/components/income/AddIncomeSourceDialog';
import { DeactivateIncomeSourceDialog } from '@/components/income/DeactivateIncomeSourceDialog';
import { EditIncomeSourceDialog } from '@/components/income/EditIncomeSourceDialog';
import {
  EditReceivedAmountDialog,
  type EditReceivedTarget,
} from '@/components/income/EditReceivedAmountDialog';
import { MarkAsReceivedDialog } from '@/components/income/MarkAsReceivedDialog';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatCard } from '@/components/shared/StatCard';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatCurrency } from '@/lib/format';
import { frequencyToMonthly } from '@/lib/frequency';
import { getFrequencyLabel, getIncomeCategoryLabel, getMonthName } from '@/lib/labels';
import { toMoneyInputString } from '@/lib/money';
import { toDisplayNumber } from '@/lib/parse';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { invalidateDashboard, trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

function toNetBrl(
  amountNative: number,
  currency: string,
  rate: number | null,
  feePercent: string | null,
): number | null {
  if (currency === 'BRL') return amountNative;
  if (rate === null) return null;
  return Money.fromNumber(amountNative, 'BRL')
    .multiply(rate)
    .multiply(Math.max(0, 1 - Number(feePercent ?? 0) / 100))
    .toNumber();
}
function rateFor(currency: string, rate: string | null): number | null {
  if (currency === 'BRL') return 1;
  const value = Number(rate);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function sourcesWithoutRate(
  sources: { account: { currency: string }; config: { exchangeRate: string | null } | null }[],
) {
  return sources.some(
    (source) => rateFor(source.account.currency, source.config?.exchangeRate ?? null) === null,
  );
}

export function IncomeClient() {
  const locale = useLocale();
  const t = useTranslations();
  usePageTitle(t('pageTitles.income'));

  const { data, isLoading, error } = trpc.income.list.useQuery();

  const now0 = new Date();
  const [navMonth, setNavMonth] = useState(now0.getMonth() + 1);
  const [navYear, setNavYear] = useState(now0.getFullYear());
  const utils = trpc.useUtils();
  const { data: occData } = trpc.income.occurrences.useQuery({ month: navMonth, year: navYear });
  const { data: walletData } = trpc.account.list.useQuery();
  const wallets = toArray(walletData)
    .filter((a) => a.type === 'checking' && a.currency === 'BRL' && a.isActive)
    .map((a) => ({ id: a.id, name: a.name }));

  const [receiveTarget, setReceiveTarget] = useState<{
    transactionId: string;
    label: string;
    isForex: boolean;
    grossBrl: string | null;
  } | null>(null);
  const [walletId, setWalletId] = useState('');
  const [amountBrl, setAmountBrl] = useState('');

  const markReceived = trpc.income.markOccurrenceAsReceived.useMutation({
    onSuccess: () => {
      toast.success(t('income.markReceived.success'));
      utils.income.occurrences.invalidate();
      utils.income.list.invalidate();
      invalidateDashboard(utils);
      utils.account.list.invalidate();
      setReceiveTarget(null);
      setWalletId('');
      setAmountBrl('');
    },
    onError: (err) => toast.error(err.message || t('income.markReceived.error')),
  });

  const undoPayroll = trpc.income.undoPayroll.useMutation({
    onSuccess: () => {
      utils.income.invalidate();
      utils.loan.invalidate();
      utils.account.invalidate();
      utils.projection.invalidate();
      utils.simulator.invalidate();
      invalidateDashboard(utils);
    },
    onError: (error) => toast.error(error.message),
  });
  const incomplete = sourcesWithoutRate(data ?? []);
  const occByAccount = new Map((occData ?? []).map((s) => [s.accountId, s]));

  const prevMonth = () => {
    if (navMonth === 1) {
      setNavMonth(12);
      setNavYear((y) => y - 1);
    } else setNavMonth((m) => m - 1);
  };
  const nextMonth = () => {
    if (navMonth === 12) {
      setNavMonth(1);
      setNavYear((y) => y + 1);
    } else setNavMonth((m) => m + 1);
  };

  const [showAdd, setShowAdd] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<{ id: string; name: string } | null>(
    null,
  );

  const sources = (data ?? []).filter((item) => item.config != null && item.schedule != null);
  type IncomeSource = (typeof sources)[number];
  const [editingSource, setEditingSource] = useState<IncomeSource | null>(null);
  const [editTarget, setEditTarget] = useState<EditReceivedTarget | null>(null);

  const monthlyTotal = sources.reduce((sum, item) => {
    if (item.config == null || item.schedule == null) return sum;
    const base = toDisplayNumber(item.schedule.amount);
    const rate = rateFor(item.account.currency, item.config.exchangeRate);
    const netBrl = toNetBrl(base, item.account.currency, rate, item.config.conversionFeePercent);
    return sum + (netBrl ?? 0) * frequencyToMonthly(item.config.frequency);
  }, 0);

  // One-time incomes (frequency 'once') are excluded from the recurring monthly
  // total. The current-month figure adds back the ones whose occurrence lands in
  // the current calendar month, so it reflects what is actually received now.
  const now = new Date();
  const curMonth = now.getMonth() + 1;
  const curYear = now.getFullYear();
  const oneTimeThisMonth = sources.reduce((sum, item) => {
    if (item.config == null || item.schedule == null || item.config.frequency !== 'once') {
      return sum;
    }
    const d = new Date(item.schedule.startDate);
    if (d.getUTCMonth() + 1 !== curMonth || d.getUTCFullYear() !== curYear) return sum;
    const rate = rateFor(item.account.currency, item.config.exchangeRate);
    return (
      sum +
      (toNetBrl(
        toDisplayNumber(item.schedule.amount),
        item.account.currency,
        rate,
        item.config.conversionFeePercent,
      ) ?? 0)
    );
  }, 0);
  const currentMonthIncome = monthlyTotal + oneTimeThisMonth;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('income.title')}
        subtitle={t('income.subtitle')}
        actions={
          <Button variant="brand" size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="size-4" /> {t('income.actions.add')}
          </Button>
        }
      />

      {incomplete && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('cashForecast.incomplete')}
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard
          tone="income"
          label={t('income.stats.monthlyTotal')}
          value={<AmountDisplay amount={monthlyTotal} variant="income" />}
          icon={<TrendingUp className="size-4" />}
        />
        <StatCard
          tone="income"
          label={t('income.stats.currentMonth', { month: getMonthName(curMonth, locale) })}
          value={<AmountDisplay amount={currentMonthIncome} variant="income" />}
          icon={<CalendarDays className="size-4" />}
        />
        <StatCard
          tone="neutral"
          label={t('income.stats.activeCount')}
          value={sources.length}
          icon={<Wallet className="size-4" />}
        />
      </div>

      <div className="flex items-center justify-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={prevMonth}
          aria-label={t('common.previous')}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-40 text-center font-medium">
          {getMonthName(navMonth, locale)} {navYear}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={nextMonth} aria-label={t('common.next')}>
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {skeletonKeys(3).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      )}

      {error && (
        <div className="text-expense">
          {t('common.error')}: {error.message}
        </div>
      )}

      {data && sources.length === 0 && (
        <EmptyState
          icon={<TrendingUp className="size-12" />}
          title={t('income.noIncome')}
          action={
            <Button variant="brand" onClick={() => setShowAdd(true)}>
              <Plus className="size-4" /> {t('income.actions.add')}
            </Button>
          }
        />
      )}

      {sources.length > 0 && (
        <div className="space-y-3">
          {sources.map((item) => {
            const config = item.config;
            const schedule = item.schedule;
            if (config == null || schedule == null) return null;
            const startDate = new Date(schedule.startDate);
            const startMonth = startDate.getUTCMonth() + 1;
            const startYear = startDate.getUTCFullYear();
            const isForex = item.account.currency !== 'BRL';
            // Amount is stored in the source's own currency. For forex sources
            // also show the BRL equivalent at the source's stored rate — the same
            // rate the server uses, so this matches the dashboard.
            const rate = rateFor(item.account.currency, config.exchangeRate);
            const amountNative = toDisplayNumber(schedule.amount);
            const amountBrl = toNetBrl(
              amountNative,
              item.account.currency,
              rate,
              config.conversionFeePercent,
            );

            const src = occByAccount.get(item.account.id);
            const occurrences = src?.occurrences ?? [];
            const allReceived =
              occurrences.length > 0 &&
              occurrences.every((o) => o.isPaid && o.settlementSource !== 'date_assumed');
            // Net BRL received/projected this month = sum of each occurrence's
            // server-computed net BRL (single source of truth, exact dashboard
            // parity; handles 2 OR 3 biweekly payments automatically).
            const monthlyOccBrl = occurrences.reduce((acc, occ) => acc + Number(occ.amountBrl), 0);

            return (
              <Card key={item.account.id}>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid size-9 shrink-0 place-items-center rounded-full bg-income/10 text-income">
                        <RefreshCw className="size-4" />
                      </div>
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-semibold">{item.account.name}</p>
                          {occurrences.length > 0 && (
                            <StatusBadge status={allReceived ? 'paid' : 'pending'} />
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="income">{getFrequencyLabel(t, config.frequency)}</Badge>
                          <Badge variant="outline">
                            {getIncomeCategoryLabel(t, config.category)}
                          </Badge>
                          {config.paymentDay != null && (
                            <span className="text-xs text-muted-foreground">
                              {t('income.row.day')} {config.paymentDay}
                            </span>
                          )}
                          {isForex && (
                            <span className="text-xs text-muted-foreground">
                              {rate === null ? t('cashForecast.unavailable') : formatCurrency(rate)}
                              /{item.account.currency}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {t('income.row.since')} {getMonthName(startMonth, locale)} {startYear}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isForex ? (
                        <div className="flex flex-col items-end leading-tight">
                          <AmountDisplay
                            amount={amountNative}
                            currency={item.account.currency}
                            variant="income"
                            size="lg"
                          />
                          <span className="text-xs text-muted-foreground font-numeric tabular-nums">
                            {amountBrl === null
                              ? t('cashForecast.unavailable')
                              : `≈ ${formatCurrency(amountBrl)}`}
                          </span>
                        </div>
                      ) : (
                        <AmountDisplay amount={amountNative} variant="income" size="lg" />
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditingSource(item)}
                        aria-label={t('income.actions.edit')}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          setDeactivateTarget({ id: item.account.id, name: item.account.name })
                        }
                        aria-label={t('income.deactivate.title')}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>

                  {occurrences.length > 0 && (
                    <div className="flex items-center justify-between gap-2 border-t pt-3 text-sm">
                      <span className="text-muted-foreground">
                        {t('cashForecast.economicIncome')}
                      </span>
                      <span className="font-semibold font-numeric tabular-nums text-income">
                        {formatCurrency(monthlyOccBrl)}
                        {occurrences.some((occ) => occ.amountBrl === null) &&
                          ` · ${t('cashForecast.incomplete')}`}
                      </span>
                    </div>
                  )}

                  {isForex && (
                    <p className="text-xs text-muted-foreground">
                      {t('cashForecast.configuredFx', {
                        rate: config.exchangeRate ?? t('cashForecast.unavailable'),
                        currency: item.account.currency,
                        fee: config.conversionFeePercent,
                        date: new Date(config.updatedAt).toLocaleDateString(),
                      })}
                    </p>
                  )}
                  {src?.needsPayrollAllocation && (
                    <p className="text-sm text-muted-foreground">
                      {Number(src.unlinkedPayrollBrl) > 0
                        ? t('cashForecast.unlinkedPayroll', {
                            deductions: formatCurrency(Number(src.unlinkedPayrollBrl)),
                          })
                        : t('cashForecast.pendingPayroll', {
                            deductions: formatCurrency(Number(src.pendingPayrollBrl)),
                            net:
                              src.pendingNetDepositBrl === null
                                ? t('cashForecast.unavailable')
                                : formatCurrency(Number(src.pendingNetDepositBrl)),
                          })}
                    </p>
                  )}
                  {occurrences.length > 0 && (
                    <ul className="space-y-1">
                      {occurrences.map((occ) => {
                        // Server-computed net BRL — single source of truth,
                        // exact dashboard parity (no client-side rounding).
                        const occBrl = occ.amountBrl === null ? null : Number(occ.amountBrl);
                        const occLabel = `${item.account.name} — ${new Date(
                          `${occ.date}T00:00:00Z`,
                        ).toLocaleDateString(locale, { timeZone: 'UTC' })}`;
                        return (
                          <li
                            key={occ.transactionId}
                            className="flex items-center justify-between gap-2 text-sm"
                          >
                            <span className="flex items-center gap-2">
                              <span className="font-numeric tabular-nums text-muted-foreground">
                                {new Date(`${occ.date}T00:00:00Z`).toLocaleDateString(locale, {
                                  timeZone: 'UTC',
                                })}
                              </span>
                              <span className="font-numeric tabular-nums">
                                {occBrl === null
                                  ? t('cashForecast.unavailable')
                                  : formatCurrency(occBrl)}
                              </span>
                              <Badge variant="outline">
                                {t(`cashForecast.provenance.${occ.settlementSource}`)}
                              </Badge>
                              {occ.cashConfirmed && (
                                <span className="text-xs">
                                  {t('cashForecast.netDeposit')}:{' '}
                                  {formatCurrency(Number(occ.cashAmountBrl))}
                                </span>
                              )}
                            </span>
                            {occ.settlementSource === 'payroll' ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={undoPayroll.isPending}
                                onClick={() =>
                                  undoPayroll.mutate({ incomeTransactionId: occ.transactionId })
                                }
                              >
                                {t('cashForecast.undoPayroll')}
                              </Button>
                            ) : occ.isPaid && occ.settlementSource !== 'date_assumed' ? (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('income.editReceived.title')}
                                onClick={() =>
                                  setEditTarget({
                                    transactionId: occ.transactionId,
                                    label: occLabel,
                                    amountBrl: occ.cashAmountBrl ?? '',
                                  })
                                }
                              >
                                <Pencil className="size-4" />
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  const isForexOcc = item.account.currency !== 'BRL';
                                  // A forex occurrence only has a usable prefill when the
                                  // source's stored rate is known. Otherwise leave the BRL
                                  // field empty so the user types it.
                                  const hasRate =
                                    item.account.currency === 'BRL' || config.exchangeRate != null;
                                  setReceiveTarget({
                                    transactionId: occ.transactionId,
                                    label: occLabel,
                                    isForex: isForexOcc,
                                    grossBrl: occ.amountBrl,
                                  });
                                  setWalletId('');
                                  setAmountBrl(
                                    isForexOcc && hasRate && occBrl !== null
                                      ? occBrl.toFixed(2)
                                      : '',
                                  );
                                }}
                              >
                                {t('income.markReceived.action')}
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AddIncomeSourceDialog open={showAdd} onOpenChange={setShowAdd} />
      {editingSource && (
        <EditIncomeSourceDialog
          open={editingSource != null}
          onOpenChange={(v) => {
            if (!v) setEditingSource(null);
          }}
          source={editingSource}
        />
      )}
      <DeactivateIncomeSourceDialog
        open={deactivateTarget != null}
        onOpenChange={(v) => {
          if (!v) setDeactivateTarget(null);
        }}
        accountId={deactivateTarget?.id ?? null}
        name={deactivateTarget?.name ?? ''}
      />
      {receiveTarget && (
        <MarkAsReceivedDialog
          key={receiveTarget.transactionId}
          transactionId={receiveTarget.transactionId}
          grossBrl={receiveTarget.grossBrl}
          open={receiveTarget != null}
          onOpenChange={(v) => {
            if (!v) setReceiveTarget(null);
          }}
          walletId={walletId}
          setWalletId={setWalletId}
          wallets={wallets}
          occurrenceLabel={receiveTarget.label}
          {...(receiveTarget.isForex ? { amountBrl, setAmountBrl } : {})}
          isPending={markReceived.isPending}
          onConfirm={(settlementDate) => {
            if (receiveTarget.isForex) {
              const parsed = toMoneyInputString(amountBrl);
              if (!parsed) {
                toast.error(t('income.markReceived.invalidAmount'));
                return;
              }
              markReceived.mutate({
                transactionId: receiveTarget.transactionId,
                settlementDate,
                paidToAccountId: walletId,
                amountBrl: parsed,
              });
            } else {
              markReceived.mutate({
                transactionId: receiveTarget.transactionId,
                settlementDate,
                paidToAccountId: walletId,
              });
            }
          }}
        />
      )}
      <EditReceivedAmountDialog
        open={editTarget != null}
        onOpenChange={(v) => {
          if (!v) setEditTarget(null);
        }}
        target={editTarget}
      />
    </div>
  );
}
