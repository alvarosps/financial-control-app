'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

export type PurchaseCoverageData =
  inferRouterOutputs<AppRouter>['purchaseInbox']['coverage'][number];

export function PurchaseCoverage({
  coverage,
  compact = false,
}: {
  coverage: PurchaseCoverageData;
  compact?: boolean;
}) {
  const t = useTranslations('purchases');
  const locale = useLocale();
  const cycle = coverage.lastReconciledCycle;
  const timestamp = (date: Date) =>
    date.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  return (
    <div className={compact ? 'mt-3 space-y-2 text-xs' : 'rounded-lg border p-3 space-y-3 text-sm'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {!compact && <strong>{coverage.cardName}</strong>}
        <Badge variant="outline">{t(`coverage.states.${coverage.state}`)}</Badge>
        <Link
          href={`/purchases?card=${coverage.cardAccountId}`}
          className="underline underline-offset-4 min-h-11 inline-flex items-center"
        >
          {t('coverage.view')}
        </Link>
      </div>
      {coverage.pending > 0 && <p>{t('pending', { count: coverage.pending })}</p>}
      {!compact && <p className="text-muted-foreground">{t('partialCoverage')}</p>}
      <details>
        <summary className="cursor-pointer min-h-11 flex items-center">
          {t('coverage.details')}
        </summary>
        <div className="space-y-3 pt-2">
          {cycle && (
            <p>
              {t('coverage.reconciled', {
                period: `${String(cycle.month).padStart(2, '0')}/${cycle.year}`,
              })}{' '}
              {cycle.estimated && t('coverage.estimated')}
            </p>
          )}
          <p className="text-muted-foreground">{t('coverage.closedCycle')}</p>
          <ul className="space-y-3">
            {coverage.sources.map((source) => (
              <li key={source.source} className="space-y-1 border-t pt-2">
                <div className="flex flex-wrap gap-2">
                  <strong>{t(`sources.${source.source}`)}</strong>
                  <span>{t(`coverage.states.${source.state}`)}</span>
                </div>
                {source.lastEventReceivedAt && (
                  <p>{t('coverage.received', { date: timestamp(source.lastEventReceivedAt) })}</p>
                )}
                {source.lastImportAppliedAt && (
                  <p>{t('coverage.imported', { date: timestamp(source.lastImportAppliedAt) })}</p>
                )}
                <p className="text-muted-foreground">{t('coverage.noFetch')}</p>
                <p className="text-muted-foreground">{t('coverage.noProviderUpdate')}</p>
                {source.coveredThrough && (
                  <p>
                    {t('coverage.through', {
                      date: new Date(`${source.coveredThrough}T12:00:00Z`).toLocaleDateString(
                        locale,
                      ),
                    })}
                  </p>
                )}
                {source.error && <p>{t('coverage.difference')}</p>}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

export function PurchaseCoveragePanel({ cardAccountId }: { cardAccountId?: string }) {
  const t = useTranslations('purchases');
  const query = trpc.purchaseInbox.coverage.useQuery({ cardAccountId }, { retry: false });
  if (query.isPending) return <p role="status">{t('coverage.loading')}</p>;
  if (query.error)
    return (
      <div role="alert">
        <p>{t('coverage.loadError')}</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  return (
    <div className="space-y-3">
      {toArray(query.data).map((coverage) => (
        <PurchaseCoverage key={coverage.cardAccountId} coverage={coverage} />
      ))}
    </div>
  );
}
