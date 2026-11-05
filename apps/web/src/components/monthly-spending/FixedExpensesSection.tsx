'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import {
  CollapsibleSpendingSection,
  SPENDING_TONES,
} from '@/components/monthly-spending/CollapsibleSpendingSection';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

type FixedExpenseData =
  inferRouterOutputs<AppRouter>['monthlySpending']['get']['fixedExpenses'][number];
type FixedCategory = FixedExpenseData['fixedCategory'];

type Props = {
  expenses: FixedExpenseData[];
};

const CATEGORY_CONFIG: Record<FixedCategory, { labelKey: string; order: number }> = {
  anuidade: { labelKey: 'monthlySpending.fixedCategories.anuidade', order: 0 },
  assinatura: { labelKey: 'monthlySpending.fixedCategories.assinatura', order: 1 },
  seguro: { labelKey: 'monthlySpending.fixedCategories.seguro', order: 2 },
  conta: { labelKey: 'monthlySpending.fixedCategories.conta', order: 3 },
  outro: { labelKey: 'monthlySpending.fixedCategories.outro', order: 4 },
};

const tone = SPENDING_TONES.fixed;

function SubAccordion({ label, items }: { label: string; items: FixedExpenseData[] }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  // Money strings from the API; parseFloat only at the display boundary.
  const total = items.reduce((sum, expense) => sum + Number.parseFloat(expense.amount), 0);

  return (
    <div className={cn('overflow-hidden rounded-lg border', tone.itemBorder)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex w-full items-center justify-between px-4 py-2.5 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          tone.itemHover,
        )}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={cn(
              'size-3.5 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">
            {t('monthlySpending.itemsCount', { count: items.length })}
          </span>
        </div>
        <span className={cn('font-numeric text-sm font-semibold tabular-nums', tone.text)}>
          {formatCurrency(total)}
        </span>
      </button>
      {open && (
        <div className="divide-y divide-border/50 border-t">
          {items.map((expense) => (
            <div
              key={expense.id}
              className="flex items-center justify-between gap-2 px-4 py-2 text-xs"
            >
              <div className="min-w-0">
                <span className="truncate">{expense.description}</span>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                    {expense.source}
                  </Badge>
                  {expense.categoryName && (
                    <span className="text-[10px] text-muted-foreground">
                      {expense.categoryName}
                    </span>
                  )}
                </div>
              </div>
              <span className={cn('shrink-0 font-numeric font-medium tabular-nums', tone.text)}>
                {formatCurrency(Number.parseFloat(expense.amount))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FixedExpensesSection({ expenses }: Props) {
  const t = useTranslations();

  const grouped = useMemo(() => {
    const groups = new Map<FixedCategory, FixedExpenseData[]>();
    for (const expense of expenses) {
      const category = expense.fixedCategory;
      if (!groups.has(category)) groups.set(category, []);
      const items = groups.get(category);
      if (items) items.push(expense);
    }
    return [...groups.entries()].sort(
      (a, b) => CATEGORY_CONFIG[a[0]].order - CATEGORY_CONFIG[b[0]].order,
    );
  }, [expenses]);

  if (expenses.length === 0) return null;

  const total = expenses.reduce((sum, expense) => sum + Number.parseFloat(expense.amount), 0);

  return (
    <CollapsibleSpendingSection
      tone="fixed"
      icon={RefreshCw}
      title={t('monthlySpending.sections.fixedExpenses')}
      badge={
        <Badge variant="secondary" className="text-[10px]">
          {t('monthlySpending.itemsCount', { count: expenses.length })}
        </Badge>
      }
      total={total}
      bodyClassName="space-y-2 p-3 pt-0"
    >
      {grouped.map(([category, items]) => (
        <SubAccordion key={category} label={t(CATEGORY_CONFIG[category].labelKey)} items={items} />
      ))}
    </CollapsibleSpendingSection>
  );
}
