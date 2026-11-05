'use client';

import type { AppRouter } from '@fc/api';
import { keepPreviousData } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { CalendarDays, Pencil, Plus, Receipt, Trash2, Undo2, Wallet } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { AddChargeDialog } from '@/components/charges/AddChargeDialog';
import { DeactivateChargeDialog } from '@/components/charges/DeactivateChargeDialog';
import { EditChargeDialog } from '@/components/charges/EditChargeDialog';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { FinancialObligationAction } from '@/components/shared/FinancialObligationAction';
import { MonthNavigator } from '@/components/shared/MonthNavigator';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatCard } from '@/components/shared/StatCard';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useMonthNavigation } from '@/hooks/useMonthNavigation';
import { usePageTitle } from '@/hooks/usePageTitle';
import { invalidateFinancialPosition } from '@/lib/invalidate';
import { getChargeKindLabel, getMonthName } from '@/lib/labels';
import { toDisplayNumber } from '@/lib/parse';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';

type ChargeRow = inferRouterOutputs<AppRouter>['charges']['list']['fixed'][number];
type ChargeTab = 'fixed' | 'oneTime';

export function ChargesClient({
  initialMonth,
  initialYear,
}: {
  initialMonth: number;
  initialYear: number;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const utils = trpc.useUtils();
  usePageTitle(t('pageTitles.charges'));
  const { month, year, goToPreviousMonth, goToNextMonth } = useMonthNavigation(
    initialMonth,
    initialYear,
  );

  const {
    data,
    isPending: isListPending,
    isPlaceholderData,
    error,
  } = trpc.charges.list.useQuery({ month, year }, { placeholderData: keepPreviousData });
  const obligations = trpc.transaction.obligations.useQuery({ month, year });
  const showSkeleton = isListPending && data === undefined;
  const [tab, setTab] = useState<ChargeTab>('fixed');
  const [showAdd, setShowAdd] = useState(false);
  const [addKind, setAddKind] = useState<ChargeTab>('fixed');
  const [editingCharge, setEditingCharge] = useState<ChargeRow | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const onUndoSuccess = async () => {
    await invalidateFinancialPosition(utils);
    toast.success(t('dashboard.undoSuccess'));
  };
  const onError = (err: { message: string }) => {
    toast.error(err.message || t('dashboard.markPaidFailed'));
  };
  const onSettled = () => {
    setActiveKey(null);
  };

  const undoCharge = trpc.charges.markOccurrenceAsUnpaid.useMutation({
    onSuccess: onUndoSuccess,
    onError,
    onSettled,
  });
  const isPending = undoCharge.isPending;
  const undoCharRow = (item: ChargeRow) => {
    if (item.transactionId == null) return;
    setActiveKey(item.id);
    undoCharge.mutate({ transactionId: item.transactionId });
  };

  const fixed = data?.fixed ?? [];
  const oneTime = data?.oneTime ?? [];

  const fixedMonthlyTotal = fixed.reduce((sum, item) => sum + toDisplayNumber(item.amount), 0);
  const oneTimeMonthTotal = oneTime.reduce((sum, item) => sum + toDisplayNumber(item.amount), 0);
  const activeCount = fixed.length + oneTime.length;

  const rows = tab === 'fixed' ? fixed : oneTime;

  function openAdd(kind: ChargeTab) {
    setAddKind(kind);
    setShowAdd(true);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('charges.title')}
        subtitle={t('charges.subtitle')}
        actions={
          <MonthNavigator
            month={month}
            year={year}
            onPrev={goToPreviousMonth}
            onNext={goToNextMonth}
            buttonSize="icon-lg"
          />
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard
          tone="expense"
          label={t('charges.stats.fixedMonthly')}
          value={<AmountDisplay amount={fixedMonthlyTotal} variant="expense" />}
          icon={<Receipt className="size-4" />}
        />
        <StatCard
          tone="expense"
          label={t('charges.stats.oneTimeMonth', { month: getMonthName(month, locale) })}
          value={<AmountDisplay amount={oneTimeMonthTotal} variant="expense" />}
          icon={<CalendarDays className="size-4" />}
        />
        <StatCard
          tone="neutral"
          label={t('charges.stats.activeCount')}
          value={activeCount}
          icon={<Wallet className="size-4" />}
        />
      </div>

      {/* Tab toggle + add action */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant={tab === 'fixed' ? 'brand' : 'outline'}
            size="sm"
            onClick={() => setTab('fixed')}
          >
            {t('charges.tabs.fixed')}
          </Button>
          <Button
            variant={tab === 'oneTime' ? 'brand' : 'outline'}
            size="sm"
            onClick={() => setTab('oneTime')}
          >
            {t('charges.tabs.oneTime')}
          </Button>
        </div>
        <Button variant="brand" size="sm" onClick={() => openAdd(tab)}>
          <Plus className="size-4" />{' '}
          {tab === 'fixed' ? t('charges.actions.addFixed') : t('charges.actions.addOneTime')}
        </Button>
      </div>

      {showSkeleton && (
        <div className="space-y-3">
          {skeletonKeys(3).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      )}

      {error && <ErrorAlert message={error.message} />}

      {data && rows.length === 0 && (
        <EmptyState
          icon={<Receipt className="size-12" />}
          title={tab === 'fixed' ? t('charges.empty.fixed') : t('charges.empty.oneTime')}
          action={
            <Button variant="brand" onClick={() => openAdd(tab)}>
              <Plus className="size-4" />{' '}
              {tab === 'fixed' ? t('charges.actions.addFixed') : t('charges.actions.addOneTime')}
            </Button>
          }
        />
      )}

      {data && rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((item) => (
            <Card key={item.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-9 shrink-0 place-items-center rounded-full bg-expense/10 text-expense">
                    <Receipt className="size-4" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="truncate font-semibold">{item.description}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{getChargeKindLabel(t, item.frequency)}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {item.dueDay != null
                          ? t('charges.row.day', { day: item.dueDay })
                          : t('charges.row.noDueDay')}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <AmountDisplay
                    amount={toDisplayNumber(item.amount)}
                    variant="expense"
                    size="lg"
                  />
                  {item.transactionId != null && (
                    <StatusBadge status={item.isPaid ? 'paid' : 'pending'} />
                  )}
                  {item.isPaid &&
                    (() => {
                      const obligation = obligations.data?.items.find(
                        (o) =>
                          o.ref.kind === 'charge' && o.ref.transactionId === item.transactionId,
                      );
                      return (
                        obligation && (
                          <p className="text-xs text-muted-foreground">
                            {obligation.settledAt
                              ? new Date(obligation.settledAt).toLocaleDateString(locale, {
                                  timeZone: 'America/Sao_Paulo',
                                })
                              : t('financial.dateUnknown')}{' '}
                            · {t(`financial.evidence.${obligation.evidence}`)}
                          </p>
                        )
                      );
                    })()}
                  {item.transactionId != null &&
                    !item.isPaid &&
                    (() => {
                      const obligation = obligations.data?.items.find(
                        (o) =>
                          o.ref.kind === 'charge' && o.ref.transactionId === item.transactionId,
                      );
                      return obligation ? (
                        <FinancialObligationAction
                          item={obligation}
                          disabled={isPlaceholderData || obligations.isFetching}
                        />
                      ) : null;
                    })()}
                  {item.transactionId != null &&
                    item.isPaid &&
                    obligations.data?.items.some(
                      (o) =>
                        o.ref.kind === 'charge' &&
                        o.ref.transactionId === item.transactionId &&
                        o.canUndo,
                    ) && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={isPlaceholderData || (isPending && activeKey === item.id)}
                        aria-label={t('dashboard.undo')}
                        title={t('dashboard.undo')}
                        onClick={() => undoCharRow(item)}
                      >
                        <Undo2 className="size-4" />
                      </Button>
                    )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEditingCharge(item)}
                    aria-label={t('charges.actions.edit')}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDeactivateTarget({ id: item.id, name: item.description })}
                    aria-label={t('charges.deactivate.title')}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AddChargeDialog open={showAdd} onOpenChange={setShowAdd} defaultKind={addKind} />
      {editingCharge && (
        <EditChargeDialog
          open={editingCharge != null}
          onOpenChange={(v) => {
            if (!v) setEditingCharge(null);
          }}
          charge={editingCharge}
        />
      )}
      <DeactivateChargeDialog
        open={deactivateTarget != null}
        onOpenChange={(v) => {
          if (!v) setDeactivateTarget(null);
        }}
        scheduleId={deactivateTarget?.id ?? null}
        name={deactivateTarget?.name ?? ''}
      />
    </div>
  );
}
