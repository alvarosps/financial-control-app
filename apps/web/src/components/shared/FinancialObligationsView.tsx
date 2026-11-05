'use client';

import type { FinancialObligation, FinancialObligationRef } from '@fc/shared';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { ErrorAlert } from './ErrorAlert';
import { FinancialObligationAction } from './FinancialObligationAction';

export function FinancialObligationsView({
  month,
  year,
  accountId,
  kind,
  initialFilter = 'all',
  onFilterChange,
  extraAction,
}: {
  month: number;
  year: number;
  accountId?: string;
  kind?: FinancialObligationRef['kind'];
  initialFilter?: string;
  onFilterChange?: (filter: string) => void;
  extraAction?: (item: FinancialObligation) => ReactNode;
}) {
  const t = useTranslations('financial');
  const [localFilter, setLocalFilter] = useState(initialFilter);
  const filter = onFilterChange ? initialFilter : localFilter;
  const setFilter = (value: string) => {
    setLocalFilter(value);
    onFilterChange?.(value);
  };
  const [page, setPage] = useState(0);
  const { data, error, isPending, refetch } = trpc.transaction.obligations.useQuery({
    month,
    year,
    accountId,
    kind,
  });
  if (error) return <ErrorAlert message={error.message} onRetry={() => void refetch()} />;
  if (isPending) return <p role="status">…</p>;
  if (!data) return null;
  const items = data.items.filter(
    (i) =>
      filter === 'all' ||
      (filter === 'settled' && i.status === 'settled') ||
      ((filter === 'payable' || filter === 'receivable') &&
        i.direction === filter &&
        (i.status === 'open' || i.status === 'partial')),
  );
  const visible = items.slice(page * 40, (page + 1) * 40);
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('dueBasis')}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {(['payable', 'receivable', 'review'] as const).map((key) => (
          <Card key={key}>
            <CardContent className="pt-4">
              <Button
                variant="ghost"
                onClick={() => {
                  setFilter(key);
                  setPage(0);
                }}
              >
                {t(key)} (
                {key === 'payable'
                  ? data.summary.payableCount
                  : key === 'receivable'
                    ? data.summary.receivableCount
                    : data.summary.reviewCount}
                )
              </Button>
              {key !== 'review' && (
                <p className="font-numeric tabular-nums">
                  {formatCurrency(
                    Number(key === 'payable' ? data.summary.toPay : data.summary.toReceive),
                  )}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {(['all', 'payable', 'receivable', 'settled', 'review'] as const).map((key) => (
          <Button
            key={key}
            variant={filter === key ? 'default' : 'outline'}
            onClick={() => {
              setFilter(key);
              setPage(0);
            }}
          >
            {t(key)}
          </Button>
        ))}
      </div>
      {filter === 'review' ? (
        <div className="space-y-2">
          {data.reviewIssues.length === 0 && <p>{t('empty')}</p>}
          {data.reviewIssues.map((issue) => (
            <Card key={issue.key}>
              <CardContent className="py-4">
                <Link className="underline" href={issue.detailHref}>
                  {issue.name}
                </Link>
                <p className="text-sm text-warning">{t(`issues.${issue.reason}`)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <>
          {visible.length === 0 && <p>{t('empty')}</p>}
          {visible.map((item) => (
            <Card key={item.key}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <Link href={item.detailHref} className="font-medium underline">
                    {item.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {item.dueDate ?? t('dateUnknown')} · {t(`status.${item.status}`)}
                  </p>
                  {item.evidence === 'legacy' && (
                    <p className="text-xs text-muted-foreground">{t('legacy')}</p>
                  )}
                </div>
                <div className="text-right font-numeric tabular-nums">
                  <p>
                    {t('total')}: {formatCurrency(Number(item.total))}
                  </p>
                  {item.confirmedCash !== null && (
                    <p>
                      {t('confirmedCash')}: {formatCurrency(Number(item.confirmedCash))}
                    </p>
                  )}
                  {item.status !== 'settled' && (
                    <p>
                      {t('remaining')}: {formatCurrency(Number(item.remaining))}
                    </p>
                  )}
                </div>
                <FinancialObligationAction item={item} />
                {extraAction?.(item)}
              </CardContent>
            </Card>
          ))}
          <div className="flex gap-2">
            <Button variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              {t('previous')}
            </Button>
            <Button
              variant="outline"
              disabled={(page + 1) * 40 >= items.length}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('next')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
