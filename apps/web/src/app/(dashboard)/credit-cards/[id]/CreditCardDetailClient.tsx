'use client';

import { SYSTEM_ACCOUNT_NAMES } from '@fc/shared';
import { keepPreviousData } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AdditionalCards } from '@/components/credit-cards/detail/AdditionalCards';
import { BillComposition } from '@/components/credit-cards/detail/BillComposition';
import { BillHistory } from '@/components/credit-cards/detail/BillHistory';
import { BillPanel } from '@/components/credit-cards/detail/BillPanel';
import { BillPanelMobile } from '@/components/credit-cards/detail/BillPanelMobile';
import { BillStatus } from '@/components/credit-cards/detail/BillStatus';
import {
  mapFixedCharges,
  mapInstallments,
  mapMonthlyExpenses,
  mapRefunds,
} from '@/components/credit-cards/detail/billCompositionMappers';
import { ConsolidatedBillCard } from '@/components/credit-cards/detail/ConsolidatedBillCard';
import { CreditCardHeader } from '@/components/credit-cards/detail/CreditCardHeader';
import {
  type DeleteTarget,
  DetailDialogs,
  type DialogKey,
} from '@/components/credit-cards/detail/DetailDialogs';
import { ProjectionGrid } from '@/components/credit-cards/detail/ProjectionGrid';
import { QuickSummary } from '@/components/credit-cards/detail/QuickSummary';
import { useCardSchedules } from '@/components/credit-cards/detail/useCardSchedules';
import { FaturaProfileSelect } from '@/components/credit-cards/import/FaturaProfileSelect';
import { FaturaReviewDialog } from '@/components/credit-cards/import/FaturaReviewDialog';
import { ImportFaturaDialog } from '@/components/credit-cards/import/ImportFaturaDialog';
import { CreditCardVisual } from '@/components/shared/CreditCardVisual';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { writeMonthYearToUrl } from '@/hooks/useMonthNavigation';
import { usePageTitle } from '@/hooks/usePageTitle';
import { cardColor } from '@/lib/card-color';
import { formatCurrency } from '@/lib/format';
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

function advanceMonth(m: number, y: number) {
  return m === 12 ? { month: 1, year: y + 1 } : { month: m + 1, year: y };
}
function retreatMonth(m: number, y: number) {
  return m === 1 ? { month: 12, year: y - 1 } : { month: m - 1, year: y };
}

export function CreditCardDetailClient({
  cardId,
  initialMonth,
  initialYear,
}: {
  cardId: string;
  initialMonth: number;
  initialYear: number;
}) {
  const t = useTranslations();

  const { data: account, isLoading: accountLoading } = trpc.account.getById.useQuery({
    id: cardId,
  });
  usePageTitle(account?.name ?? t('pageTitles.creditCards'));

  const searchParams = useSearchParams();
  const paramMonth = searchParams.get('month');
  const paramYear = searchParams.get('year');

  // Current month/year are server-seeded (fixed TZ) so the bill-month selector
  // renders identically on server and client — no hydration mismatch.
  const calMonth = initialMonth;
  const calYear = initialYear;

  const [billMonth, setBillMonth] = useState(() => {
    if (paramMonth) {
      const m = parseInt(paramMonth, 10);
      if (!Number.isNaN(m) && m >= 1 && m <= 12) return m;
    }
    return calMonth;
  });
  const [billYear, setBillYear] = useState(() => {
    if (paramYear) {
      const y = parseInt(paramYear, 10);
      if (!Number.isNaN(y)) return y;
    }
    return calYear;
  });
  const [autoAdvanced, setAutoAdvanced] = useState(() => {
    return !!(paramMonth || paramYear);
  });
  const userNavigated = useRef(false);

  const [openDialog, setOpenDialog] = useState<DialogKey>(null);
  const [editItemId, setEditItemId] = useState<string | null>(null);
  const [editTxId, setEditTxId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reviewImportId, setReviewImportId] = useState<string | null>(null);

  const { data: config, isLoading: configLoading } = trpc.creditCard.getConfig.useQuery({
    accountId: cardId,
  });
  const { data: bill, isPending: billPending } = trpc.creditCard.getBill.useQuery(
    { cardAccountId: cardId, month: billMonth, year: billYear },
    { placeholderData: keepPreviousData },
  );
  const billLoading = billPending && bill === undefined;
  const { data: rawAccounts } = trpc.account.list.useQuery();
  const { data: rawSchedules } = trpc.scheduled.list.useQuery();
  const { data: categories } = trpc.category.list.useQuery();
  const allAccounts = toArray(rawAccounts);
  const schedules = toArray(rawSchedules);

  const prev = retreatMonth(billMonth, billYear);
  const { data: prevBill } = trpc.creditCard.getBill.useQuery(
    { cardAccountId: cardId, month: prev.month, year: prev.year },
    { placeholderData: keepPreviousData },
  );

  useEffect(() => {
    userNavigated.current = false;
    setAutoAdvanced(false);
  }, []);

  const { installments, fixedCharges, monthlyExpenses, totalUsed } = useCardSchedules(
    schedules,
    cardId,
  );

  const scheduleIdSet = useMemo(() => new Set(schedules.map((s) => s.id)), [schedules]);

  const additionalCards = useMemo(
    () => allAccounts.filter((a) => a.parentAccountId === cardId && a.isActive),
    [allAccounts, cardId],
  );

  const { data: consolidated } = trpc.creditCard.getConsolidatedBill.useQuery(
    { cardAccountId: cardId, month: billMonth, year: billYear },
    // Keep the previous period's consolidated values while a new month loads so
    // the side panel + pay dialog never flash the principal-only total.
    { enabled: additionalCards.length > 0, placeholderData: (prev) => prev },
  );

  // When the card has additional cards, the side panel + pay action reflect the
  // CONSOLIDATED fatura (principal + children) — which is exactly what payBill
  // settles. Single cards keep using their own getBill data.
  const hasAdditional = additionalCards.length > 0;
  const consolidatedPanel = hasAdditional ? (consolidated ?? null) : null;
  const consolidatedReady = !hasAdditional || consolidated != null;
  const effectiveIsPaid = consolidatedPanel ? consolidatedPanel.isPaid : (bill?.isPaid ?? false);
  const effectiveTxCount = consolidatedPanel
    ? consolidatedPanel.transactionCount
    : (bill?.transactionCount ?? 0);

  // Auto-advance to next month when the (consolidated) current bill is settled
  // or empty. Wait for the consolidated query so we never skip a principal that
  // looks paid while a child still owes.
  useEffect(() => {
    if (
      !autoAdvanced &&
      !userNavigated.current &&
      bill &&
      consolidatedReady &&
      (effectiveIsPaid || effectiveTxCount === 0) &&
      billMonth === calMonth &&
      billYear === calYear
    ) {
      const next = advanceMonth(calMonth, calYear);
      setBillMonth(next.month);
      setBillYear(next.year);
      writeMonthYearToUrl(next.month, next.year);
      setAutoAdvanced(true);
    }
  }, [
    bill,
    consolidatedReady,
    effectiveIsPaid,
    effectiveTxCount,
    autoAdvanced,
    billMonth,
    billYear,
    calMonth,
    calYear,
  ]);

  const defaultSourceAccountId = useMemo(
    () =>
      allAccounts.find(
        (a) =>
          a.type === 'expense' &&
          a.isActive &&
          a.name === SYSTEM_ACCOUNT_NAMES.CREDIT_CARD_EXPENSES,
      )?.id ?? '',
    [allAccounts],
  );

  const paymentAccounts = useMemo(
    () =>
      allAccounts
        .filter((a) => a.type === 'checking' && a.isActive && a.currency === 'BRL')
        .map((a) => ({ id: a.id, name: a.name })),
    [allAccounts],
  );

  const cats = useMemo(
    () => categories?.map((c) => ({ id: c.id, name: c.name })) ?? [],
    [categories],
  );

  const utils = trpc.useUtils();
  // Deleting a scheduled installment deactivates the schedule AND purges its
  // unpaid materialized rows (so it actually leaves the bill). Works for active
  // and already-inactive schedules — fixes the old reverse-a-schedule-id 500.
  const scheduledDelete = trpc.scheduled.delete.useMutation({
    onSuccess: async () => {
      await invalidateCreditCardContext(utils);
      setOpenDialog(null);
      setDeleteTarget(null);
    },
  });
  const reverseTransaction = trpc.transaction.reverse.useMutation({
    onSuccess: async () => {
      await invalidateCreditCardContext(utils);
      setOpenDialog(null);
      setDeleteTarget(null);
    },
  });

  const isLoading = accountLoading || configLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <SkeletonCard />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonCard />
      </div>
    );
  }

  if (!account) {
    return <ErrorAlert message={t('app-dashboard-credit-cards-id-page.cardNotFound')} />;
  }

  const billTransactions = bill?.transactions ?? [];

  const editTx = billTransactions.find((tx) => tx.id === editTxId) ?? null;

  // The edit dialog edits a schedule, but the user clicked a specific bill row.
  // An installment schedule always stores starting_occurrence=1 + the first-parcela
  // amount, so we feed the dialog the CURRENT row's parcela + amount instead.
  const editRow = editItemId
    ? billTransactions.find(
        (tx) =>
          tx.scheduledTransactionId === editItemId && tx.domainType === 'credit_card_installment',
      )
    : undefined;
  const editCurrentInstallment = editRow?.installmentNumber ?? null;
  const editCurrentAmount = editRow ? String(editRow.amount) : null;

  const goToBillMonth = (month: number, year: number) => {
    userNavigated.current = true;
    setBillMonth(month);
    setBillYear(year);
    writeMonthYearToUrl(month, year);
  };
  const onPrevMonth = () => {
    const previous = retreatMonth(billMonth, billYear);
    goToBillMonth(previous.month, previous.year);
  };
  const onNextMonth = () => {
    const next = advanceMonth(billMonth, billYear);
    goToBillMonth(next.month, next.year);
  };

  return (
    <>
      <div className="flex gap-6">
        <div className="flex-1 min-w-0 space-y-6">
          <CreditCardHeader
            cardName={account.name}
            closingDay={config?.closingDay}
            dueDay={config?.dueDay}
            creditLimit={config?.creditLimit ?? null}
            onAddInstallment={() => setOpenDialog('installment')}
            onAddExpense={() => setOpenDialog('expense')}
            onAddRefund={() => setOpenDialog('refund')}
            onAddAdditionalCard={() => setOpenDialog('additional')}
            onEditCard={() => setOpenDialog('edit-card')}
            onImportFatura={() => setImportOpen(true)}
          />

          <FaturaProfileSelect cardId={cardId} />

          {consolidated && additionalCards.length > 0 && (
            <ConsolidatedBillCard total={consolidated.total} breakdown={consolidated.breakdown} />
          )}

          <CreditCardVisual
            name={account.name}
            dueDay={config?.dueDay}
            dueLabel={t('creditCards.dueDayShort')}
            color={account.color ?? cardColor(cardId)}
            status={bill ? <BillStatus total={bill.total} isPaid={bill.isPaid} /> : undefined}
            bill={
              <span className="text-2xl font-bold font-numeric tabular-nums text-white">
                {formatCurrency(bill ? bill.total : 0)}
              </span>
            }
          />

          <QuickSummary
            closingDay={config?.closingDay ?? 1}
            dueDay={config?.dueDay ?? 1}
            dueDate={bill?.dueDate ?? null}
            dueDateSource={bill?.dueDateSource}
            creditLimit={config?.creditLimit ?? null}
            currentBillTotal={bill ? bill.total : 0}
            totalUsed={totalUsed}
            previousBillTotal={prevBill ? prevBill.total : null}
            currentBillMonth={billMonth}
            currentBillYear={billYear}
          />

          <div className="md:hidden">
            <BillPanelMobile
              bill={bill}
              consolidated={consolidatedPanel}
              isLoading={billLoading}
              month={billMonth}
              year={billYear}
              onPrevMonth={onPrevMonth}
              onNextMonth={onNextMonth}
              onPayBill={() => setOpenDialog('pay')}
            />
          </div>

          <BillComposition
            installments={mapInstallments(billTransactions, schedules)}
            fixedCharges={mapFixedCharges(billTransactions, schedules)}
            monthlyExpenses={mapMonthlyExpenses(billTransactions)}
            refunds={mapRefunds(billTransactions)}
            categories={cats}
            month={billMonth}
            year={billYear}
            onEditItem={(id) => {
              if (scheduleIdSet.has(id)) {
                setEditItemId(id);
                setOpenDialog('edit');
                return;
              }
              // One-time expense/refund: `id` is a transaction id. Guard against a
              // schedule-backed-but-inactive row (its id is a schedule id absent from
              // scheduleIdSet) so we never open the dialog with a null transaction.
              if (!billTransactions.some((tx) => tx.id === id)) return;
              setEditTxId(id);
              setOpenDialog('edit-transaction');
            }}
            onDeleteItem={(id, name, isScheduled) => {
              setDeleteTarget({ id, name, type: isScheduled ? 'scheduled' : 'refund' });
              setOpenDialog('delete');
            }}
            onDeleteRefund={(id, name) => {
              setDeleteTarget({ id, name, type: 'refund' });
              setOpenDialog('delete');
            }}
          />

          <ProjectionGrid
            installments={installments}
            fixedCharges={fixedCharges}
            monthlyExpenses={monthlyExpenses}
          />

          <BillHistory cardId={cardId} onSelectMonth={goToBillMonth} />

          <AdditionalCards cards={additionalCards.map((a) => ({ id: a.id, name: a.name }))} />
        </div>

        <div className="hidden md:block">
          <BillPanel
            bill={bill}
            consolidated={consolidatedPanel}
            month={billMonth}
            year={billYear}
            onPrevMonth={onPrevMonth}
            onNextMonth={onNextMonth}
            onPayBill={() => setOpenDialog('pay')}
            isLoading={billLoading}
          />
        </div>
      </div>

      <DetailDialogs
        cardId={cardId}
        openDialog={openDialog}
        setOpenDialog={setOpenDialog}
        editItemId={editItemId}
        setEditItemId={setEditItemId}
        editCurrentInstallment={editCurrentInstallment}
        editCurrentAmount={editCurrentAmount}
        deleteTarget={deleteTarget}
        setDeleteTarget={setDeleteTarget}
        closingDay={config?.closingDay ?? 1}
        dueDay={config?.dueDay ?? 10}
        defaultSourceAccountId={defaultSourceAccountId}
        categories={cats}
        billMonth={billMonth}
        billYear={billYear}
        billTotal={consolidatedPanel ? consolidatedPanel.total : (bill?.total ?? 0)}
        paymentAmount={
          consolidatedPanel ? consolidatedPanel.unpaidTotal : Math.max(0, bill?.unpaidTotal ?? 0)
        }
        paymentAccounts={paymentAccounts}
        onConfirmDelete={() => {
          if (!deleteTarget) return;
          if (deleteTarget.type === 'scheduled') scheduledDelete.mutate({ id: deleteTarget.id });
          else reverseTransaction.mutate({ id: deleteTarget.id });
        }}
        deleteLoading={scheduledDelete.isPending || reverseTransaction.isPending}
        editCardAccount={{ id: account.id, name: account.name, color: account.color }}
        editTransaction={editTx}
        setEditTxId={setEditTxId}
        editCardConfig={
          config
            ? {
                closingDay: config.closingDay,
                dueDay: config.dueDay,
                creditLimit: config.creditLimit,
                isDueDayVariable: config.isDueDayVariable,
              }
            : null
        }
      />
      <ImportFaturaDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        cardId={cardId}
        hasProfile={Boolean(config?.billParserType)}
        onDraftCreated={setReviewImportId}
      />
      {reviewImportId !== null ? (
        <FaturaReviewDialog
          importId={reviewImportId}
          open={true}
          onOpenChange={(open) => {
            if (!open) setReviewImportId(null);
          }}
          defaultSourceAccountId={defaultSourceAccountId}
        />
      ) : null}
    </>
  );
}
