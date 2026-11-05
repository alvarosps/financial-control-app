'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { ErrorAlert } from './ErrorAlert';

export function CashMovementsView({
  month,
  year,
  accountId,
}: {
  month: number;
  year: number;
  accountId?: string;
}) {
  const t = useTranslations('financial');
  const [page, setPage] = useState(1);
  const query = trpc.transaction.cashMovements.useQuery({
    month,
    year,
    accountId,
    page,
    pageSize: 40,
  });
  if (query.error)
    return <ErrorAlert message={query.error.message} onRetry={() => void query.refetch()} />;
  if (!query.data) return <p role="status">…</p>;
  const data = query.data;
  return (
    <section className="space-y-3">
      <p>
        {t('cash')}: +{formatCurrency(Number(data.incoming))} / −
        {formatCurrency(Number(data.outgoing))}
      </p>
      {data.unconfirmedCount > 0 && (
        <p className="text-warning">
          {t('notConfirmed')} ({data.unconfirmedCount})
        </p>
      )}
      {data.items.map((item) => (
        <div key={item.id} className="flex flex-wrap justify-between gap-3 border-b py-3">
          <div>
            {item.name}
            <p className="text-xs text-muted-foreground">
              {item.date} {!item.confirmed && ` · ${t('legacy')}`}
            </p>
          </div>
          <span className="font-numeric tabular-nums">
            {item.amount === null ? '—' : formatCurrency(Number(item.amount))}
          </span>
        </div>
      ))}
      <Button variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
        {t('previous')}
      </Button>
      <Button
        variant="outline"
        disabled={page * 40 >= data.total}
        onClick={() => setPage((p) => p + 1)}
      >
        {t('next')}
      </Button>
    </section>
  );
}
