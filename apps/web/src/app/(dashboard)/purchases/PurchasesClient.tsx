'use client';
import type { PurchaseReview } from '@fc/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { FinancialAlerts } from '@/components/alerts/FinancialAlerts';
import { ClassificationPanel } from '@/components/purchases/ClassificationPanel';
import { PurchaseCoveragePanel } from '@/components/purchases/PurchaseCoverage';
import { PurchaseReviewSheet } from '@/components/purchases/PurchaseReviewSheet';
import { PurchaseSelect } from '@/components/purchases/PurchaseSelect';
import { QuickAdd } from '@/components/quick-add/QuickAdd';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { usePageTitle } from '@/hooks/usePageTitle';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

type Period = 'today' | 'yesterday' | 'week' | 'unknown' | 'all';
function offset(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function PurchasesClient({
  initialDay,
  initialCardId = 'all',
}: {
  initialDay: string;
  initialCardId?: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  usePageTitle(t('purchases.title'));
  const online = useOnlineStatus();
  const [period, setPeriod] = useState<Period>('week');
  const [card, setCard] = useState(initialCardId);
  const [review, setReview] = useState<PurchaseReview | 'all'>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [classificationOpen, setClassificationOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const accounts = trpc.account.list.useQuery();
  const dateFilter =
    period === 'unknown'
      ? { unknownDate: true }
      : period === 'all'
        ? {}
        : {
            fromDate: offset(initialDay, period === 'week' ? -6 : period === 'yesterday' ? -1 : 0),
            toDate: offset(initialDay, period === 'yesterday' ? -1 : 0),
          };
  const query = trpc.purchaseInbox.list.useInfiniteQuery(
    {
      ...dateFilter,
      limit: 20,
      ...(card === 'all' ? {} : { cardAccountId: card }),
      ...(review === 'all' ? {} : { review }),
    },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, retry: false },
  );
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = query.data?.pages[0]?.counts;
  const pending = (counts?.unreviewed ?? 0) + (counts?.needs_review ?? 0);
  return (
    <div className="space-y-5 pb-20">
      <PageHeader
        title={t('purchases.title')}
        subtitle={t('purchases.subtitle')}
        actions={<QuickAdd inline />}
      />
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <Badge>{t('purchases.pending', { count: pending })}</Badge>
        <span className="text-sm text-muted-foreground">{t('purchases.partialCoverage')}</span>
      </div>
      <PurchaseCoveragePanel cardAccountId={card === 'all' ? undefined : card} />
      <FinancialAlerts
        month={Number(initialDay.slice(5, 7))}
        year={Number(initialDay.slice(0, 4))}
      />
      <Button
        variant="outline"
        aria-expanded={classificationOpen}
        onClick={() => setClassificationOpen(!classificationOpen)}
      >
        {t('classification.title')}
      </Button>
      {classificationOpen && <ClassificationPanel initialMonth={initialDay.slice(0, 7)} />}
      {!online && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {t('purchases.offline')}
        </p>
      )}
      <fieldset className="flex flex-wrap gap-2" aria-label={t('purchases.period')}>
        {(['today', 'yesterday', 'week', 'unknown', 'all'] as const).map((value) => (
          <Button
            key={value}
            variant={period === value ? 'default' : 'outline'}
            className="min-h-11"
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
          >
            {t(`purchases.periods.${value}`)}
          </Button>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <PurchaseSelect
          id="purchase-card-filter"
          label={t('purchases.card')}
          value={card}
          onChange={setCard}
          options={[
            { value: 'all', label: t('purchases.allCards') },
            ...toArray(accounts.data)
              .filter((item) => item.type === 'credit_card')
              .map((item) => ({ value: item.id, label: item.name })),
          ]}
        />
        <PurchaseSelect
          id="purchase-review-filter"
          label={t('purchases.reviewFilter')}
          value={review}
          onChange={(value) => setReview(value as PurchaseReview | 'all')}
          options={[
            { value: 'all', label: t('purchases.allReviews') },
            ...(['unreviewed', 'needs_review', 'accepted', 'ignored'] as const).map((value) => ({
              value,
              label: t(`purchases.reviews.${value}`),
            })),
          ]}
        />
      </div>
      {query.error && (
        <div role="alert" className="space-y-2 rounded-lg border p-4">
          <p>{t('purchases.loadError')}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {t('purchases.retry')}
          </Button>
        </div>
      )}
      {query.isPending && !query.error && <p role="status">{t('purchases.loading')}</p>}
      {!query.isPending && !query.error && rows.length === 0 && (
        <p className="rounded-lg border p-6 text-muted-foreground">{t('purchases.empty')}</p>
      )}
      <ul className="space-y-3" aria-label={t('purchases.title')}>
        {rows.map((item) => (
          <li key={item.id}>
            <Card surface="solid" className="gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="break-words font-heading text-base font-medium">
                    {item.description}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {item.cardName ?? t('purchases.unknownCard')}
                  </p>
                </div>
                <AmountDisplay
                  amount={Number(item.amount)}
                  currency={item.currency}
                  variant={item.kind === 'refund' ? 'income' : 'neutral'}
                  className="shrink-0"
                />
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>
                  {item.purchaseDate
                    ? new Intl.DateTimeFormat(locale, { timeZone: 'UTC' }).format(
                        new Date(`${item.purchaseDate}T12:00:00Z`),
                      )
                    : t('purchases.unknownDate')}
                </span>
                {item.totalInstallments && item.totalInstallments > 1 && (
                  <span>{t('purchases.installments', { count: item.totalInstallments })}</span>
                )}
                {item.kind === 'refund' && <span>{t('purchases.refund')}</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {item.sources.map((source) => (
                  <Badge key={source} variant="secondary">
                    {t(`purchases.sources.${source}`)}
                  </Badge>
                ))}
                <Badge variant="outline">{t(`purchases.confirmations.${item.confirmation}`)}</Badge>
                <Badge variant="outline">{t(`purchases.reviews.${item.review}`)}</Badge>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                <div className="text-sm">
                  <span className="mr-2 text-muted-foreground">
                    {t(
                      item.application === 'unapplied'
                        ? 'purchases.estimated'
                        : 'purchases.applied',
                    )}
                  </span>
                  {(item.application === 'unapplied' ? item.estimatedTotal : item.appliedAmount) !==
                  null ? (
                    <AmountDisplay
                      amount={Number(
                        item.application === 'unapplied' ? item.estimatedTotal : item.appliedAmount,
                      )}
                      currency={item.currency}
                      variant="neutral"
                      size="sm"
                    />
                  ) : (
                    <span>{t('purchases.amountUnknown')}</span>
                  )}
                  {item.ledgerReversed && <p>{t('purchases.reversed')}</p>}
                </div>
                <Button
                  variant="outline"
                  className="min-h-11"
                  aria-label={t('purchases.reviewNamed', { name: item.description })}
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    setSelected(item.id);
                  }}
                >
                  {t('purchases.review')}
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="outline"
          className="min-h-11 w-full"
          disabled={query.isFetchingNextPage || !online}
          onClick={() => void query.fetchNextPage()}
        >
          {t('purchases.more')}
        </Button>
      )}
      <PurchaseReviewSheet
        purchaseId={selected}
        onClose={() => {
          setSelected(null);
          trigger.current?.focus();
        }}
      />
    </div>
  );
}
