import { CheckCircle2, Clock, ListChecks } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { StatCard } from '@/components/shared/StatCard';
import { formatCurrency } from '@/lib/format';

type Props = {
  summary: {
    totalItems: number;
    paidCount: number;
    pendingCount: number;
    totalIn: number;
    totalOut: number;
    balance: number;
    payableCount?: number;
    receivableCount?: number;
    toPay?: string;
    toReceive?: string;
    settledPayable?: string;
    settledReceivable?: string;
  };
};

export function DailySummary({ summary }: Props) {
  const t = useTranslations();

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <StatCard
        tone="neutral"
        label={t('daily.totalItems')}
        value={summary.totalItems}
        icon={<ListChecks className="size-4" />}
      />
      <StatCard
        tone="income"
        label={t('financial.receivable')}
        value={summary.receivableCount ?? 0}
        icon={<CheckCircle2 className="size-4" />}
        delta={{ label: formatCurrency(Number(summary.toReceive ?? 0)), direction: 'up' }}
      />
      <StatCard
        tone="expense"
        label={t('financial.payable')}
        value={summary.payableCount ?? 0}
        icon={<Clock className="size-4" />}
        delta={{ label: formatCurrency(Number(summary.toPay ?? 0)), direction: 'down' }}
      />
      <StatCard
        tone="neutral"
        label={t('financial.settled')}
        value={summary.paidCount}
        icon={<CheckCircle2 className="size-4" />}
        delta={{
          label: t('financial.settledNominal', {
            outgoing: formatCurrency(Number(summary.settledPayable ?? 0)),
            incoming: formatCurrency(Number(summary.settledReceivable ?? 0)),
          }),
          direction: 'neutral',
        }}
      />
    </div>
  );
}
