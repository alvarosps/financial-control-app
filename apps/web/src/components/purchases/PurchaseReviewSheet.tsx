'use client';
import type { AppRouter } from '@fc/api';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { MoneyField } from '@/components/shared/MoneyField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { currentFatura } from '@/lib/billing';
import { dateInputToDate, todayLocalISO } from '@/lib/dates';
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';
import { PurchaseSelect } from './PurchaseSelect';

type Detail = inferRouterOutputs<AppRouter>['purchaseInbox']['detail'];
type Changes = inferRouterInputs<AppRouter>['purchaseInbox']['review']['changes'];
const noId = '00000000-0000-4000-8000-000000000000';

export function PurchaseReviewSheet({
  purchaseId,
  onClose,
}: {
  purchaseId: string | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const query = trpc.purchaseInbox.detail.useQuery(
    { id: purchaseId ?? noId },
    { enabled: purchaseId !== null, retry: false, refetchOnWindowFocus: false },
  );
  return (
    <Sheet
      open={purchaseId !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[90dvh] max-w-2xl overflow-y-auto rounded-t-2xl pb-[max(env(safe-area-inset-bottom),1rem)]"
        showCloseButton={!busy}
      >
        <SheetHeader>
          <SheetTitle>{t('purchases.reviewTitle')}</SheetTitle>
          <SheetDescription>{t('purchases.reviewDescription')}</SheetDescription>
        </SheetHeader>
        {query.isPending && (
          <p role="status" className="px-4">
            {t('purchases.loading')}
          </p>
        )}
        {query.error && (
          <div role="alert" className="px-4">
            <p>{t('purchases.loadError')}</p>
            <Button onClick={() => void query.refetch()}>{t('purchases.retry')}</Button>
          </div>
        )}
        {query.data && (
          <ReviewForm
            key={`${query.data.purchase.id}:${query.data.purchase.version}`}
            detail={query.data}
            onClose={onClose}
            onBusy={setBusy}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ReviewForm({
  detail,
  onClose,
  onBusy,
}: {
  detail: Detail;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const { purchase } = detail;
  const institutionEvidence = detail.institutionEvidence ?? [];
  const relatedPurchases = detail.relatedPurchases ?? [];
  const institutionCycle = institutionEvidence.find(
    (row) =>
      row.cycle &&
      !row.retractedAt &&
      !row.cycleIssue &&
      (purchase.installmentNumber === null || row.installmentNumber === purchase.installmentNumber),
  )?.cycle;
  const needsDistinctReview = detail.candidates.length > 0 || relatedPurchases.length > 0;
  const t = useTranslations();
  const locale = useLocale();
  const dayLabel = (day: string | null) =>
    day
      ? new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' })
      : t('purchases.unknownDate');
  const utils = trpc.useUtils();
  const online = useOnlineStatus();
  const [description, setDescription] = useState(purchase.description);
  const [amount, setAmount] = useState(purchase.amount);
  const [date, setDate] = useState(purchase.purchaseDate ?? '');
  const [card, setCard] = useState(purchase.cardAccountId ?? 'none');
  const [category, setCategory] = useState(purchase.categoryId ?? 'none');
  const [meaning, setMeaning] = useState(purchase.amountMeaning);
  const [installment, setInstallment] = useState(purchase.installmentNumber?.toString() ?? '');
  const [total, setTotal] = useState(purchase.totalInstallments?.toString() ?? '');
  const [expense, setExpense] = useState('');
  const [cycle, setCycle] = useState('');
  const [distinct, setDistinct] = useState(false);
  const [guidance, setGuidance] = useState(purchase.unrecognized);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const accounts = trpc.account.list.useQuery();
  const categories = trpc.category.list.useQuery();
  const configs = trpc.creditCard.listConfigs.useQuery();
  const expenseId =
    expense ||
    toArray(accounts.data).find((item) => item.type === 'expense' && item.isActive)?.id ||
    '';
  const config = configs.data?.find((item) => item.accountId === card);
  const suggestedCycle = config
    ? currentFatura(dateInputToDate(date || todayLocalISO()), config.closingDay)
    : null;
  const selectedCycle =
    cycle ||
    (institutionCycle
      ? `${institutionCycle.billingYear}-${String(institutionCycle.billingMonth).padStart(2, '0')}`
      : '') ||
    (suggestedCycle
      ? `${suggestedCycle.year}-${String(suggestedCycle.month).padStart(2, '0')}`
      : '');
  const review = trpc.purchaseInbox.review.useMutation();
  const accept = trpc.purchaseInbox.accept.useMutation();
  const link = trpc.purchaseInbox.link.useMutation();
  const ignore = trpc.purchaseInbox.ignore.useMutation();
  const unlink = trpc.purchaseInbox.unlink.useMutation();
  const reprocess = trpc.purchaseInbox.reprocess.useMutation();
  const separateEvidence = trpc.purchaseInbox.separateEvidence.useMutation();
  const identity = { observationId: purchase.id, version: purchase.version };
  const applied = purchase.application !== 'unapplied';

  async function run(action: () => Promise<unknown>, close = true) {
    if (busy || !online) return;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      await action();
      await invalidateCreditCardContext(utils);
      if (close) onClose();
    } catch {
      setError(t('purchases.saveError'));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  function corrections(): Changes {
    const normalized = toMoneyInputString(amount);
    if (!normalized) throw new Error('Invalid amount');
    const fields = {
      description: description.trim(),
      amount: normalized,
      purchaseDate: date || null,
      cardAccountId: card === 'none' ? null : card,
      categoryId: category === 'none' ? null : category,
      amountMeaning: meaning,
      installmentNumber: installment ? Number(installment) : null,
      totalInstallments: total ? Number(total) : null,
    };
    return Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) => value !== purchase[key as keyof typeof fields],
      ),
    ) as Changes;
  }
  async function saveCorrections() {
    const changes = corrections();
    return Object.keys(changes).length ? review.mutateAsync({ ...identity, changes }) : purchase;
  }
  return (
    <div className="space-y-4 px-4">
      <h3 className="break-words font-heading text-base font-medium">{purchase.description}</h3>
      {institutionEvidence.length > 0 && (
        <section
          className="space-y-2 rounded-lg border p-3 text-sm"
          aria-label={t('integration.institutionEvidence')}
        >
          <h4 className="font-medium">{t('integration.institutionEvidence')}</h4>
          {institutionEvidence.map((row) => (
            <div key={row.movementId}>
              {row.cardLastFour && (
                <p>{t('integration.cardEnding', { lastFour: row.cardLastFour })}</p>
              )}
              {row.cycle && (
                <p>
                  {t('integration.statementDates', {
                    closing: dayLabel(row.cycle.closingDate),
                    due: dayLabel(row.cycle.dueDate),
                  })}
                </p>
              )}
              {row.cycleIssue && <p role="status">{t('integration.cycleIssue')}</p>}
            </div>
          ))}
        </section>
      )}
      {relatedPurchases.length > 0 && (
        <div role="status" className="space-y-2 rounded-lg border p-3 text-sm">
          <p>{t('integration.relatedHelp')}</p>
          <ul>
            {relatedPurchases.map((row) => (
              <li className="break-words" key={row.observationId}>
                {row.description} ·{' '}
                <AmountDisplay
                  amount={Number(row.amount)}
                  currency={row.currency}
                  variant="neutral"
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {!online && <p role="status">{t('purchases.offline')}</p>}
      {error && (
        <div role="alert" className="space-y-2 rounded-lg border p-3">
          <p>{error}</p>
          <Button
            variant="outline"
            onClick={() => void utils.purchaseInbox.detail.invalidate({ id: purchase.id })}
          >
            {t('purchases.reload')}
          </Button>
        </div>
      )}
      {guidance && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {t('purchases.bankGuidance')}
        </p>
      )}
      {applied && (
        <div className="rounded-lg border p-3 text-sm">
          <p>{t('purchases.alreadyApplied')}</p>
          <AmountDisplay
            amount={Number(purchase.appliedAmount)}
            currency={purchase.currency}
            variant="neutral"
          />
        </div>
      )}
      {applied && purchase.link && !purchase.ledgerReversed && (
        <Button
          disabled={busy || !online || purchase.unrecognized}
          className="min-h-11 w-full"
          onClick={() =>
            void run(() => {
              const target = purchase.link?.transactionId
                ? { transactionId: purchase.link.transactionId }
                : {
                    scheduleId: purchase.link?.scheduleId ?? noId,
                    ...(purchase.link?.billingMonth && purchase.link.billingYear
                      ? {
                          billingMonth: purchase.link.billingMonth,
                          billingYear: purchase.link.billingYear,
                        }
                      : {}),
                  };
              return link.mutateAsync({ ...identity, target });
            })
          }
        >
          {t('purchases.acknowledge')}
        </Button>
      )}
      {purchase.currency !== 'BRL' && !applied && (
        <p className="text-sm text-muted-foreground">{t('purchases.foreignCurrency')}</p>
      )}
      {!applied && detail.candidates.length > 0 && (
        <section className="space-y-2" aria-label={t('purchases.candidates')}>
          <h4 className="font-medium">{t('purchases.candidates')}</h4>
          <p className="text-sm text-muted-foreground">{t('purchases.candidateHelp')}</p>
          {detail.candidates.map((candidate) => (
            <Button
              key={candidate.transactionId}
              variant="outline"
              className="h-auto min-h-11 w-full justify-between gap-3 whitespace-normal py-3"
              disabled={busy || !online}
              onClick={() =>
                void run(() =>
                  link.mutateAsync({
                    ...identity,
                    target: { transactionId: candidate.transactionId },
                  }),
                )
              }
            >
              <span className="min-w-0 text-left">
                <span className="block">
                  {t('purchases.linkNamed', { name: candidate.description })}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t('purchases.candidateDate', {
                    date: candidate.date.toLocaleDateString(locale, { timeZone: 'UTC' }),
                  })}
                  {candidate.billingMonth && candidate.billingYear && (
                    <>
                      {' '}
                      ·{' '}
                      {t('purchases.candidateCycle', {
                        period: `${String(candidate.billingMonth).padStart(2, '0')}/${candidate.billingYear}`,
                      })}
                    </>
                  )}
                  {candidate.installmentNumber && candidate.totalInstallments && (
                    <>
                      {' '}
                      ·{' '}
                      {t('purchases.candidateInstallment', {
                        number: candidate.installmentNumber,
                        total: candidate.totalInstallments,
                      })}
                    </>
                  )}
                  {candidate.suggested && <> · {t('purchases.suggested')}</>}
                </span>
              </span>
              <AmountDisplay
                amount={Number(candidate.amount)}
                currency={purchase.currency}
                variant="neutral"
                size="sm"
              />
            </Button>
          ))}
        </section>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(saveCorrections, false);
        }}
        className="space-y-3"
      >
        <fieldset disabled={busy || applied || !online} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="review-description">{t('purchases.merchant')}</Label>
            <Input
              id="review-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={200}
              required
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <MoneyField
              id="review-amount"
              label={t('purchases.observedAmount')}
              value={amount}
              onChange={setAmount}
              required
            />
            <PurchaseSelect
              id="review-meaning"
              label={t('purchases.meaning')}
              value={meaning}
              onChange={(value) => setMeaning(value as typeof meaning)}
              options={(['unknown', 'purchase_total', 'installment'] as const).map((value) => ({
                value,
                label: t(`purchases.meanings.${value}`),
              }))}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="review-installment">{t('purchases.installmentNumber')}</Label>
              <Input
                id="review-installment"
                type="number"
                min={1}
                max={120}
                value={installment}
                onChange={(event) => setInstallment(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="review-total">{t('purchases.totalInstallments')}</Label>
              <Input
                id="review-total"
                type="number"
                min={1}
                max={120}
                value={total}
                onChange={(event) => setTotal(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="review-date">{t('quickAdd.purchaseDate')}</Label>
            <Input
              id="review-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('purchases.dateHelp')}</p>
          </div>
          <PurchaseSelect
            id="review-card"
            label={t('purchases.card')}
            value={card}
            onChange={setCard}
            options={[
              { value: 'none', label: t('purchases.unknownCard') },
              ...toArray(accounts.data)
                .filter((item) => item.type === 'credit_card' && item.isActive)
                .map((item) => ({ value: item.id, label: item.name })),
            ]}
          />
          <PurchaseSelect
            id="review-category"
            label={t('purchases.category')}
            value={category}
            onChange={setCategory}
            options={[
              { value: 'none', label: t('quickAdd.noCategory') },
              ...(categories.data ?? [])
                .filter((item) => item.type === 'expense')
                .map((item) => ({ value: item.id, label: item.name })),
            ]}
          />
          <Button type="submit" variant="outline" className="min-h-11 w-full">
            {t('purchases.saveCorrections')}
          </Button>
        </fieldset>
      </form>
      {!applied && (
        <fieldset disabled={busy || !online} className="space-y-3">
          <PurchaseSelect
            id="review-expense"
            label={t('purchases.expenseAccount')}
            value={expenseId}
            onChange={setExpense}
            options={toArray(accounts.data)
              .filter((item) => item.type === 'expense' && item.isActive)
              .map((item) => ({ value: item.id, label: item.name }))}
          />
          <div className="space-y-2">
            <Label htmlFor="review-cycle">{t('purchases.closingPeriod')}</Label>
            <Input
              id="review-cycle"
              type="month"
              value={selectedCycle}
              onChange={(event) => setCycle(event.target.value)}
            />
          </div>
          {needsDistinctReview && (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={distinct}
                onChange={(event) => setDistinct(event.target.checked)}
                className="size-5"
              />
              {t('purchases.distinct')}
            </label>
          )}
          {meaning === 'unknown' && (
            <p className="text-sm text-muted-foreground">{t('purchases.amountUnknown')}</p>
          )}
          <Button
            className="min-h-11 w-full"
            disabled={
              !expenseId ||
              card === 'none' ||
              !selectedCycle ||
              meaning === 'unknown' ||
              purchase.confirmation === 'retracted' ||
              purchase.unrecognized ||
              purchase.review === 'ignored' ||
              purchase.currency !== 'BRL' ||
              (needsDistinctReview && !distinct)
            }
            onClick={() =>
              void run(async () => {
                const corrected = await saveCorrections();
                const [year, month] = selectedCycle.split('-').map(Number);
                await accept.mutateAsync({
                  observationId: purchase.id,
                  version: corrected.version,
                  expenseAccountId: expenseId,
                  billingMonth: month,
                  billingYear: year,
                  confirmDistinct: distinct,
                });
              })
            }
          >
            {t('purchases.register')}
          </Button>
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy || !online}
          onClick={() => {
            setGuidance(!purchase.unrecognized);
            void run(
              () =>
                review.mutateAsync({
                  ...identity,
                  changes: { unrecognized: !purchase.unrecognized },
                }),
              false,
            );
          }}
        >
          {t(purchase.unrecognized ? 'purchases.recognized' : 'purchases.unrecognized')}
        </Button>
        <Button
          variant="ghost"
          className="min-h-11"
          disabled={busy || !online}
          onClick={() => void run(() => ignore.mutateAsync(identity))}
        >
          {t('purchases.ignore')}
        </Button>
        <Button
          variant="ghost"
          className="min-h-11"
          disabled={busy || !online}
          onClick={() => void run(() => reprocess.mutateAsync(identity), false)}
        >
          {t('purchases.reprocess')}
        </Button>
        {applied && (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy || !online}
            onClick={() => void run(() => unlink.mutateAsync(identity))}
          >
            {t('purchases.unlink')}
          </Button>
        )}
      </div>
      {applied && <p className="text-xs text-muted-foreground">{t('purchases.unlinkHelp')}</p>}
      <details className="border-t pt-3 text-sm" open={purchase.review === 'needs_review'}>
        <summary className="min-h-11 cursor-pointer">{t('purchases.history')}</summary>
        <ul className="space-y-2">
          {detail.events.map((event) => (
            <li key={event.id} className="space-y-2">
              {t(`purchases.sources.${event.source}`)} ·{' '}
              {t('purchases.revisionCount', { count: event.revisions.length })}
              <ul className="space-y-3">
                {event.revisions.map((revision) => (
                  <li
                    key={revision.id}
                    className="space-y-1 rounded-lg border p-3 text-muted-foreground"
                  >
                    <p className="font-medium">
                      {t(
                        revision.sourceVersion === event.currentVersion
                          ? 'purchases.currentRevision'
                          : 'purchases.previousRevision',
                      )}
                    </p>
                    <p>
                      {t(`purchases.confirmations.${revision.data.confirmation}`)} ·{' '}
                      {revision.receivedAt.toLocaleString(locale)}
                    </p>
                    <p className="break-words">{revision.data.description}</p>
                    <AmountDisplay
                      amount={Number(revision.data.amount)}
                      currency={revision.data.currency}
                      variant="neutral"
                      size="sm"
                    />
                    <p>
                      {t(`purchases.meanings.${revision.data.amountMeaning}`)} ·{' '}
                      {t(
                        revision.data.kind === 'refund' ? 'purchases.refund' : 'purchases.purchase',
                      )}
                    </p>
                    <p>
                      {t('purchases.card')}:{' '}
                      {toArray(accounts.data).find(
                        (account) => account.id === revision.data.cardAccountId,
                      )?.name ?? t('purchases.unknownCard')}
                    </p>
                    <p>
                      {t('purchases.evidencePurchaseDate')}: {dayLabel(revision.data.purchaseDate)}
                    </p>
                    <p>
                      {t('purchases.postedDate')}: {dayLabel(revision.data.postedDate)}
                    </p>
                    {revision.data.installmentNumber && revision.data.totalInstallments && (
                      <p>
                        {t('purchases.candidateInstallment', {
                          number: revision.data.installmentNumber,
                          total: revision.data.totalInstallments,
                        })}
                      </p>
                    )}
                    {revision.sourceVersion === event.currentVersion &&
                      (
                        [
                          'amount',
                          'currency',
                          'amountMeaning',
                          'description',
                          'cardAccountId',
                          'purchaseDate',
                          'postedDate',
                          'installmentNumber',
                          'totalInstallments',
                          'kind',
                        ] as const
                      ).some((field) => revision.data[field] !== purchase[field]) && (
                        <p className="text-foreground">{t('purchases.revisionDifference')}</p>
                      )}
                  </li>
                ))}
              </ul>
              {detail.events.length > 1 && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={busy || !online}
                  onClick={() =>
                    void run(() => separateEvidence.mutateAsync({ ...identity, eventId: event.id }))
                  }
                >
                  {t('purchases.separateEvidence', {
                    source: t(`purchases.sources.${event.source}`),
                  })}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {detail.events.length > 1 && (
          <p className="mt-3 text-muted-foreground">{t('purchases.separateEvidenceHelp')}</p>
        )}
      </details>
    </div>
  );
}
