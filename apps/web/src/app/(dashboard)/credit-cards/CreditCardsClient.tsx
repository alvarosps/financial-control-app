'use client';

import { SYSTEM_ACCOUNT_NAMES } from '@fc/shared';
import { CheckCircle2, Clock, CreditCard, Plus, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AddCreditCardDialog } from '@/components/credit-cards/AddCreditCardDialog';
import { type CardSummary, CreditCardListItem } from '@/components/credit-cards/CreditCardListItem';
import {
  type BulkFaturaDraft,
  BulkFaturaReviewWizard,
} from '@/components/credit-cards/import/BulkFaturaReviewWizard';
import { BulkImportFaturaDialog } from '@/components/credit-cards/import/BulkImportFaturaDialog';
import { FaturaReviewDialog } from '@/components/credit-cards/import/FaturaReviewDialog';
import { ImportFaturaDialog } from '@/components/credit-cards/import/ImportFaturaDialog';
import {
  type BillPaymentTarget,
  QuickPayBillDialog,
} from '@/components/credit-cards/QuickPayBillDialog';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { EmptyState } from '@/components/shared/EmptyState';
import { FinancialObligationsView } from '@/components/shared/FinancialObligationsView';
import { MonthNavigator } from '@/components/shared/MonthNavigator';
import { PageHeader } from '@/components/shared/PageHeader';
import { ProgressMeter } from '@/components/shared/ProgressMeter';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatCard } from '@/components/shared/StatCard';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { useMonthNavigation } from '@/hooks/useMonthNavigation';
import { usePageTitle } from '@/hooks/usePageTitle';
import { todayLocalISO } from '@/lib/dates';
import { toDisplayNumber } from '@/lib/parse';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';
import { toArray } from '@/lib/utils';

export function CreditCardsClient() {
  const t = useTranslations();
  usePageTitle(t('pageTitles.creditCards'));
  const params = useSearchParams();
  const view = params.get('view') === 'closing' ? 'closing' : 'due';
  const setView = (value: 'closing' | 'due') => {
    const next = new URLSearchParams(window.location.search);
    next.set('view', value);
    window.history.replaceState(null, '', `${window.location.pathname}?${next}`);
  };
  const [initialYear, initialMonth] = todayLocalISO().split('-').map(Number);
  const { month, year, goToPreviousMonth, goToNextMonth } = useMonthNavigation(
    initialMonth,
    initialYear,
  );
  const [showAddCard, setShowAddCard] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkDrafts, setBulkDrafts] = useState<BulkFaturaDraft[]>([]);
  const [paymentTarget, setPaymentTarget] = useState<BillPaymentTarget | null>(null);
  const [importTarget, setImportTarget] = useState<{ cardId: string; cardName: string } | null>(
    null,
  );
  const [reviewImportId, setReviewImportId] = useState<string | null>(null);
  const actionTrigger = useRef<HTMLElement | null>(null);
  const actionCardId = useRef<string | null>(null);
  const dialogOpen =
    showAddCard ||
    showBulkImport ||
    bulkDrafts.length > 0 ||
    paymentTarget !== null ||
    importTarget !== null ||
    reviewImportId !== null;

  function rememberTrigger(card: CardSummary) {
    actionTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    actionCardId.current = card.cardId;
  }

  const returnFocus = useCallback(() => {
    return actionTrigger.current?.isConnected && actionTrigger.current !== document.body
      ? actionTrigger.current
      : document.getElementById(`credit-card-${actionCardId.current}`);
  }, []);

  useEffect(() => {
    if (!dialogOpen && actionCardId.current) {
      returnFocus()?.focus({ preventScroll: true });
      actionTrigger.current = null;
      actionCardId.current = null;
    }
  }, [dialogOpen, returnFocus]);

  const { data, isLoading, error } = trpc.creditCard.getBillSummary.useQuery();
  const configsQuery = trpc.creditCard.listConfigs.useQuery();
  const coverageQuery = trpc.purchaseInbox.coverage.useQuery({}, { retry: false });
  const accountsQuery = trpc.account.list.useQuery();
  const { data: configs } = configsQuery;
  const { data: rawAccounts } = accountsQuery;
  const accounts = toArray(rawAccounts);
  const paymentAccounts = accounts
    .filter(
      (account) => account.isActive && account.type === 'checking' && account.currency === 'BRL',
    )
    .map(({ id, name }) => ({ id, name }));

  const defaultSourceAccountId = useMemo(
    () =>
      accounts.find(
        (account) =>
          account.type === 'expense' &&
          account.isActive &&
          account.name === SYSTEM_ACCOUNT_NAMES.CREDIT_CARD_EXPENSES,
      )?.id ?? '',
    [accounts],
  );

  const configByCardId = useMemo(() => {
    const map = new Map<string, NonNullable<typeof configs>[number]>();
    for (const config of configs ?? []) map.set(config.accountId, config);
    return map;
  }, [configs]);

  const stats = useMemo(() => {
    const cards = data ?? [];
    // A credit (negative) bill means nothing is owed on that card, so it must
    // contribute 0 to the "total to pay" — never its absolute value, which
    // would inflate the month total by the credit amount.
    const totalBills = cards.reduce((sum, c) => sum + Math.max(0, c.currentBill.total), 0);
    const paid = cards.filter((c) => c.currentBill.isPaid).length;
    // A credit / zero bill owes nothing, so it is neither paid nor pending.
    const pending = cards.filter((c) => !c.currentBill.isPaid && c.currentBill.total > 0).length;
    const currentTotal = cards.reduce((sum, c) => sum + Math.max(0, c.currentBill.total), 0);
    const limitTotal = cards.reduce((sum, c) => {
      const config = configByCardId.get(c.cardId);
      return sum + (config?.creditLimit ? toDisplayNumber(config.creditLimit) : 0);
    }, 0);
    return {
      totalBills,
      paid,
      pending,
      cardCount: cards.length,
      currentTotal,
      limitTotal,
    };
  }, [data, configByCardId]);

  const limitPct = stats.limitTotal > 0 ? (stats.currentTotal / stats.limitTotal) * 100 : 0;
  const limitTone = limitPct >= 80 ? 'expense' : limitPct >= 50 ? 'warning' : 'brand';

  const sortedCards = useMemo(
    () =>
      [...(data ?? [])].sort((a, b) => (a.currentBill.dueDay ?? 99) - (b.currentBill.dueDay ?? 99)),
    [data],
  );

  const bulkImportCards = useMemo(
    () =>
      sortedCards.map((card) => ({
        id: card.cardId,
        name: card.cardName,
        profile: configByCardId.get(card.cardId)?.billParserType ?? null,
      })),
    [sortedCards, configByCardId],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('creditCards.title')}
        subtitle={t('creditCards.subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/purchases" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              {t('nav.purchases')}
            </Link>
            <Button
              variant="outline"
              size="sm"
              disabled={dialogOpen}
              onClick={() => setShowBulkImport(true)}
            >
              {t('creditCards.actions.importBulk')}
            </Button>
            <Button
              variant="brand"
              size="sm"
              disabled={dialogOpen}
              onClick={() => setShowAddCard(true)}
            >
              <Plus className="size-4" aria-hidden /> {t('creditCards.actions.add')}
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={view === 'closing' ? 'default' : 'outline'}
          onClick={() => setView('closing')}
        >
          {t('financial.closingView')}
        </Button>
        <Button variant={view === 'due' ? 'default' : 'outline'} onClick={() => setView('due')}>
          {t('financial.dueView')}
        </Button>
        {view === 'due' && (
          <MonthNavigator
            month={month}
            year={year}
            onPrev={goToPreviousMonth}
            onNext={goToNextMonth}
          />
        )}
      </div>
      {view === 'due' && (
        <FinancialObligationsView
          key={`${month}-${year}`}
          month={month}
          year={year}
          kind="card_bill"
          extraAction={(item) =>
            item.ref.kind === 'card_bill' && (
              <Button
                variant="outline"
                disabled={dialogOpen}
                onClick={() => {
                  if (item.ref.kind !== 'card_bill') return;
                  actionTrigger.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  actionCardId.current = item.ref.parentAccountId;
                  setImportTarget({ cardId: item.ref.parentAccountId, cardName: item.name });
                }}
              >
                {t('creditCards.actions.updateBill')}
              </Button>
            )
          }
        />
      )}
      {error && <div className="text-expense">{error.message}</div>}

      {!error && view === 'closing' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              tone="expense"
              label={t('creditCards.stats.totalBills')}
              value={<AmountDisplay amount={stats.totalBills} variant="expense" />}
              icon={<Receipt className="size-4" aria-hidden />}
            />
            <StatCard
              tone="income"
              label={t('creditCards.stats.paid')}
              value={stats.paid}
              icon={<CheckCircle2 className="size-4" aria-hidden />}
            />
            <StatCard
              tone="neutral"
              label={t('creditCards.stats.pending')}
              value={stats.pending}
              icon={<Clock className="size-4" aria-hidden />}
            />
            <StatCard
              tone="neutral"
              label={t('creditCards.stats.cards')}
              value={stats.cardCount}
              icon={<CreditCard className="size-4" aria-hidden />}
            />
          </div>

          {stats.limitTotal > 0 && (
            <ProgressMeter
              current={stats.currentTotal}
              total={stats.limitTotal}
              tone={limitTone}
              label={t('creditCards.stats.limitUsed')}
            />
          )}

          {isLoading && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {skeletonKeys(Math.min(configByCardId.size || 6, 6)).map((key) => (
                <SkeletonCard key={key} />
              ))}
            </div>
          )}

          {data && data.length === 0 && (
            <EmptyState
              icon={<CreditCard className="size-12" aria-hidden />}
              title={t('creditCards.empty.title')}
              description={t('creditCards.empty.description')}
              action={
                <Button variant="brand" size="sm" onClick={() => setShowAddCard(true)}>
                  <Plus className="size-4" aria-hidden /> {t('creditCards.actions.add')}
                </Button>
              }
            />
          )}

          {data && data.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {sortedCards.map((card) => {
                const config = configByCardId.get(card.cardId);
                const creditLimit = config?.creditLimit ? toDisplayNumber(config.creditLimit) : 0;
                return (
                  <CreditCardListItem
                    key={card.cardId}
                    card={card}
                    coverage={toArray(coverageQuery.data).find(
                      (item) => item.cardAccountId === card.cardId,
                    )}
                    creditLimit={creditLimit}
                    actionsDisabled={dialogOpen}
                    onPay={() => {
                      rememberTrigger(card);
                      setPaymentTarget({
                        cardId: card.cardId,
                        cardName: card.cardName,
                        month: card.currentBill.month,
                        year: card.currentBill.year,
                        dueDate: card.currentBill.dueDate,
                      });
                    }}
                    onImport={() => {
                      rememberTrigger(card);
                      setImportTarget({ cardId: card.cardId, cardName: card.cardName });
                    }}
                  />
                );
              })}
            </div>
          )}
        </>
      )}

      <AddCreditCardDialog open={showAddCard} onOpenChange={setShowAddCard} />
      {paymentTarget && (
        <QuickPayBillDialog
          key={`${paymentTarget.cardId}-${paymentTarget.year}-${paymentTarget.month}`}
          target={paymentTarget}
          onOpenChange={(open) => {
            if (!open) setPaymentTarget(null);
          }}
          paymentAccounts={paymentAccounts}
          accountsLoading={accountsQuery.isPending || accountsQuery.isFetching}
          accountsError={accountsQuery.error ? resolveTRPCError(accountsQuery.error, t) : undefined}
          onRetryAccounts={() => accountsQuery.refetch()}
          finalFocus={returnFocus}
        />
      )}
      {importTarget && (
        <ImportFaturaDialog
          key={importTarget.cardId}
          open
          onOpenChange={(open) => {
            if (!open) setImportTarget(null);
          }}
          cardId={importTarget.cardId}
          cardName={importTarget.cardName}
          hasProfile={Boolean(configByCardId.get(importTarget.cardId)?.billParserType)}
          profileSetupHref={`/credit-cards/${importTarget.cardId}`}
          onDraftCreated={setReviewImportId}
          isLoading={configsQuery.isPending || accountsQuery.isPending}
          loadError={
            configsQuery.error
              ? resolveTRPCError(configsQuery.error, t)
              : accountsQuery.error
                ? resolveTRPCError(accountsQuery.error, t)
                : !accountsQuery.isPending && !defaultSourceAccountId
                  ? t('creditCards.import.missingExpenseAccount')
                  : undefined
          }
          onRetry={() => {
            void configsQuery.refetch();
            void accountsQuery.refetch();
          }}
          finalFocus={returnFocus}
        />
      )}
      {reviewImportId && (
        <FaturaReviewDialog
          importId={reviewImportId}
          open
          onOpenChange={(open) => {
            if (!open) setReviewImportId(null);
          }}
          defaultSourceAccountId={defaultSourceAccountId}
        />
      )}
      <BulkImportFaturaDialog
        open={showBulkImport}
        onOpenChange={setShowBulkImport}
        cards={bulkImportCards}
        onDraftsReady={(drafts) => {
          setBulkDrafts(drafts);
          setShowBulkImport(false);
        }}
      />
      <BulkFaturaReviewWizard
        open={bulkDrafts.length > 0}
        onOpenChange={(open) => {
          if (!open) setBulkDrafts([]);
        }}
        drafts={bulkDrafts}
        defaultSourceAccountId={defaultSourceAccountId}
      />
    </div>
  );
}
