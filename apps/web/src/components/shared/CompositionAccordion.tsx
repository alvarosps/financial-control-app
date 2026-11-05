// src/components/shared/CompositionAccordion.tsx
'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

type Props = {
  title: string;
  count: number;
  total: number;
  color: string; // tailwind color class like 'purple' | 'cyan' | 'amber' | 'green' | 'red'
  defaultOpen?: boolean;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
};

const colorMap: Record<string, { bg: string; border: string; text: string }> = {
  purple: {
    bg: 'bg-brand-installment/5',
    border: 'border-brand-installment/20',
    text: 'text-brand-installment',
  },
  cyan: {
    bg: 'bg-brand-fixed/5',
    border: 'border-brand-fixed/20',
    text: 'text-brand-fixed',
  },
  amber: { bg: 'bg-warning/5', border: 'border-warning/20', text: 'text-warning' },
  green: { bg: 'bg-income/5', border: 'border-income/20', text: 'text-income' },
  red: { bg: 'bg-expense/5', border: 'border-expense/20', text: 'text-expense' },
};

export function CompositionAccordion({
  title,
  count,
  total,
  color,
  defaultOpen = false,
  headerExtra,
  children,
}: Props) {
  const t = useTranslations();
  const [open, setOpen] = useState(defaultOpen);
  const colors = colorMap[color] ?? colorMap.purple;

  const formatted = formatCurrency(total);

  return (
    <div className={cn('rounded-lg border', colors.bg, colors.border, 'overflow-hidden')}>
      {count > 0 ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between px-3 py-2.5 text-left"
          aria-expanded={open}
          aria-label={
            open
              ? t('shared.accordion.collapseSection', { title })
              : t('shared.accordion.expandSection', { title })
          }
        >
          <div className="flex items-center gap-2">
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out-soft)]',
                colors.text,
                open && 'rotate-90',
              )}
            />
            <span className={cn('text-sm font-semibold', colors.text)}>
              {title} ({count})
            </span>
          </div>
          <div className="flex items-center gap-2">
            {headerExtra}
            <span className="text-sm font-semibold text-foreground">{formatted}</span>
          </div>
        </button>
      ) : (
        <div className="flex w-full items-center justify-between px-3 py-2.5">
          <span className={cn('text-sm font-semibold', colors.text)}>
            {title} ({count})
          </span>
          <span className="text-sm font-semibold text-foreground">{formatted}</span>
        </div>
      )}
      {open && count > 0 && (
        <div className="px-3 pb-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-[var(--dur-fast)]">
          {children}
        </div>
      )}
    </div>
  );
}
