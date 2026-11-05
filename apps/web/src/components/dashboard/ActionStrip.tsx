'use client';

import { CalendarClock, CreditCard, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ActionChip, buildActionChips } from '@/components/dashboard/action-chips';
import { trpc } from '@/lib/trpc/client';
import { cn } from '@/lib/utils';

const CHIP_TARGET: Record<ActionChip['id'], string> = {
  cardsDue: '/credit-cards',
  billsDue: '/daily',
  incomeCredited: '/income',
};

const CHIP_ICON = {
  cardsDue: CreditCard,
  billsDue: CalendarClock,
  incomeCredited: TrendingUp,
} as const;

const CHIP_TONE: Record<ActionChip['id'], string> = {
  cardsDue: 'border-warning/30 bg-warning/10 text-warning',
  billsDue: 'border-expense/30 bg-expense/10 text-expense',
  incomeCredited: 'border-income/30 bg-income/10 text-income',
};

/** Presentational second-hero line with the financial actions requiring attention. */
export function ActionStripView({ chips }: { chips: ActionChip[] }) {
  const t = useTranslations();

  if (chips.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('dashboard.actions.allClear')}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((chip) => {
        const Icon = CHIP_ICON[chip.id];
        return (
          <Link
            key={chip.id}
            href={CHIP_TARGET[chip.id]}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium',
              'glass-hover',
              CHIP_TONE[chip.id],
            )}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {t(`dashboard.actions.${chip.id}`, { count: chip.count })}
          </Link>
        );
      })}
    </div>
  );
}

/** Derives action chips from the dashboard queries prefetched by the route. */
export function ActionStrip() {
  const { data: upcoming } = trpc.dashboard.upcomingItems.useQuery({ days: 30 });
  const { data: autoCredit } = trpc.income.autoCreditDue.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const chips = buildActionChips(upcoming ?? [], autoCredit?.credited.length ?? 0);

  return <ActionStripView chips={chips} />;
}
