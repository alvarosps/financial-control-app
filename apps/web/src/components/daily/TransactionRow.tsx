import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { Banknote, Check, Clock, CreditCard, Landmark, Receipt, ReceiptText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { FinancialObligationAction } from '@/components/shared/FinancialObligationAction';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type DailyItem =
  inferRouterOutputs<AppRouter>['dashboard']['dailyControl']['days'][number]['items'][number];

type Props = {
  item: DailyItem;
  disabled?: boolean;
};

function KindIcon({ kind, isPaid }: { kind: DailyItem['kind']; isPaid: boolean }) {
  const cls = cn('size-4 shrink-0', isPaid ? 'text-income' : 'text-warning');
  if (kind === 'card') return <CreditCard className={cls} />;
  if (kind === 'loan') return <Landmark className={cls} />;
  if (kind === 'fixed_charge') return <Receipt className={cls} />;
  if (kind === 'one_time_charge') return <ReceiptText className={cls} />;
  if (kind === 'income') return <Banknote className={cls} />;
  return isPaid ? <Check className={cls} /> : <Clock className={cls} />;
}

export function TransactionRow({ item, disabled }: Props) {
  const t = useTranslations();
  const displayAmount = item.direction === 'in' ? item.amount : -item.amount;

  return (
    <div
      className={cn(
        'flex flex-wrap gap-3 items-center justify-between py-2 px-3 rounded-lg',
        item.isPaid ? 'opacity-60' : '',
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <KindIcon kind={item.kind} isPaid={item.isPaid} />
        <div className="min-w-0">
          <p className={cn('text-sm font-medium truncate', item.isPaid && 'line-through')}>
            {item.name}
          </p>
          {item.informational && (
            <p className="text-xs text-muted-foreground">{t('cashForecast.informational')}</p>
          )}
          {item.dateUncertain && (
            <p className="text-xs text-muted-foreground">{t('cashForecast.undated')}</p>
          )}
          {item.settlementSource && (
            <p className="text-xs text-muted-foreground">
              {t(`cashForecast.provenance.${item.settlementSource}`)}
            </p>
          )}
          {item.kind === 'card' && item.billingMonth && (
            <p className="text-xs text-muted-foreground">
              {t('statement.competence', {
                period: `${String(item.billingMonth).padStart(2, '0')}/${item.billingYear}`,
              })}
              {item.dueDateSource === 'configuration' && ` · ${t('statement.estimated')}`}
            </p>
          )}
        </div>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        {item.amountUnavailable ? (
          <span className="text-xs">{t('cashForecast.unavailable')}</span>
        ) : (
          <AmountDisplay amount={displayAmount} size="sm" showSign />
        )}
        <Badge variant="outline">
          {item.obligation
            ? t(`financial.status.${item.obligation.status}`)
            : t(item.isPaid ? 'common.paid' : 'common.pending')}
        </Badge>
        {item.obligation && (
          <FinancialObligationAction item={item.obligation} disabled={disabled} />
        )}
      </div>
    </div>
  );
}
