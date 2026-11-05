import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { dateInputToDate, todayLocalISO } from '@/lib/dates';
import { TransactionRow } from './TransactionRow';

type DailyItem =
  inferRouterOutputs<AppRouter>['dashboard']['dailyControl']['days'][number]['items'][number];

type Props = {
  date: string;
  items: DailyItem[];
  disabled?: boolean;
};

export function DayGroup({ date, items, disabled }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const d = dateInputToDate(date);
  const formatted = d.toLocaleDateString(locale, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });

  const today = todayLocalISO();
  const isToday = date === today;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase">{formatted}</h3>
        {isToday && <Badge variant="brand">{t('daily.today')}</Badge>}
      </div>
      <div className="space-y-1 border-l-2 border-muted pl-4 ml-2">
        {items.map((item) => (
          <TransactionRow
            key={item.key ?? item.statementId ?? item.id}
            item={item}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}
