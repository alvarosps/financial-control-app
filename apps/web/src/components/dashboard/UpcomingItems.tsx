'use client';
import { useTranslations } from 'next-intl';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { FinancialObligationAction } from '@/components/shared/FinancialObligationAction';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { trpc } from '@/lib/trpc/client';

export function UpcomingItems() {
  const t = useTranslations();
  const query = trpc.dashboard.upcomingObligations.useQuery();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.upcoming')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.error && (
          <ErrorAlert message={query.error.message} onRetry={() => void query.refetch()} />
        )}
        {query.isPending && <p role="status">…</p>}
        {query.data?.length === 0 && <p>{t('dashboard.noUpcoming')}</p>}
        {query.data?.slice(0, 8).map((item) => (
          <div key={item.key} className="flex flex-wrap items-center justify-between gap-2">
            <div>
              {item.name}
              <p className="text-xs text-muted-foreground">{item.dueDate}</p>
            </div>
            <AmountDisplay amount={Number(item.remaining)} variant="expense" />
            <FinancialObligationAction item={item} disabled={query.isFetching} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
