'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { Banknote } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import {
  CollapsibleSpendingSection,
  SPENDING_TONES,
} from '@/components/monthly-spending/CollapsibleSpendingSection';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

type OtherExpenseData =
  inferRouterOutputs<AppRouter>['monthlySpending']['get']['otherExpenses'][number];

type Props = {
  expenses: OtherExpenseData[];
};

const tone = SPENDING_TONES.other;

function formatDateDDMM(dateStr: string): string {
  const [, month, day] = dateStr.split('-');
  return `${day}/${month}`;
}

export function OtherExpensesSection({ expenses }: Props) {
  const t = useTranslations();
  const [showAll, setShowAll] = useState(false);

  if (expenses.length === 0) return null;

  // Money strings from the API; parseFloat only at the display boundary.
  const total = expenses.reduce((sum, expense) => sum + Number.parseFloat(expense.amount), 0);
  const displayed = showAll ? expenses : expenses.slice(0, 20);

  return (
    <CollapsibleSpendingSection
      tone="other"
      icon={Banknote}
      title={t('monthlySpending.sections.otherExpenses')}
      badge={<Badge variant="secondary">{expenses.length}</Badge>}
      total={total}
      bodyClassName="divide-y divide-border/50"
    >
      {displayed.map((expense) => (
        <div
          key={expense.id}
          className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm"
        >
          <div className="min-w-0">
            <p className="truncate font-medium">{expense.description}</p>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="font-numeric text-xs text-muted-foreground tabular-nums">
                {formatDateDDMM(expense.date)}
              </span>
              {expense.categoryName && (
                <Badge variant="outline" className="text-[10px]">
                  {expense.categoryName}
                </Badge>
              )}
            </div>
          </div>
          <span className={cn('shrink-0 font-numeric font-medium tabular-nums', tone.text)}>
            {formatCurrency(Number.parseFloat(expense.amount))}
          </span>
        </div>
      ))}
      {!showAll && expenses.length > 20 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full py-2 text-center text-xs text-primary hover:underline"
          aria-label={t('monthlySpending.showMoreAria', { count: expenses.length - 20 })}
        >
          {t('monthlySpending.showMore', { count: expenses.length - 20 })}
        </button>
      )}
    </CollapsibleSpendingSection>
  );
}
