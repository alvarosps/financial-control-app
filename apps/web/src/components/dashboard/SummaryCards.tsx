'use client';

import { TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CountUpAmount } from '@/components/shared/CountUpAmount';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatCard } from '@/components/shared/StatCard';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';

export function SummaryCards({ month, year }: { month: number; year: number }) {
  const t = useTranslations();
  const { data, isLoading, error, refetch } = trpc.dashboard.monthlySummary.useQuery({
    month,
    year,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {skeletonKeys(3).map((key) => (
          <SkeletonCard key={key} />
        ))}
      </div>
    );
  }

  if (error) return <ErrorAlert message={error.message} onRetry={() => void refetch()} />;

  if (!data) return null;

  const balanceTone = data.balance >= 0 ? 'income' : 'expense';

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <StatCard
        surface="glass"
        tone="income"
        label={t('dashboard.income')}
        value={<CountUpAmount amount={data.income} size="lg" showSign variant="income" />}
        icon={<TrendingUp className="size-4" />}
      />
      <StatCard
        surface="glass"
        tone="expense"
        label={t('dashboard.expenses')}
        value={<CountUpAmount amount={-data.expenses} size="lg" showSign variant="expense" />}
        icon={<TrendingDown className="size-4" />}
      />
      <StatCard
        surface="glass"
        tone={balanceTone}
        label={t('dashboard.balance')}
        value={<CountUpAmount amount={data.balance} size="lg" showSign variant={balanceTone} />}
        icon={<Wallet className="size-4" />}
      />
    </div>
  );
}
