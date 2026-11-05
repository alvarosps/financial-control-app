'use client';

import { ChevronRight, type LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

export type SpendingTone =
  | 'cards'
  | 'grocery'
  | 'store'
  | 'marketplace'
  | 'vehicle'
  | 'loans'
  | 'fixed'
  | 'other';

export type SpendingToneClasses = {
  text: string;
  container: string;
  headerHover: string;
  itemBorder: string;
  itemHover: string;
};

// Static literals only: Tailwind's scanner must see every class.
export const SPENDING_TONES: Record<SpendingTone, SpendingToneClasses> = {
  cards: {
    text: 'text-expense',
    container: 'border-expense/15 bg-expense/5',
    headerHover: 'hover:bg-expense/10',
    itemBorder: 'border-expense/20',
    itemHover: 'hover:bg-expense/5',
  },
  grocery: {
    text: 'text-spend-grocery',
    container: 'border-spend-grocery/15 bg-spend-grocery/5',
    headerHover: 'hover:bg-spend-grocery/10',
    itemBorder: 'border-spend-grocery/20',
    itemHover: 'hover:bg-spend-grocery/5',
  },
  store: {
    text: 'text-spend-store',
    container: 'border-spend-store/15 bg-spend-store/5',
    headerHover: 'hover:bg-spend-store/10',
    itemBorder: 'border-spend-store/20',
    itemHover: 'hover:bg-spend-store/5',
  },
  marketplace: {
    text: 'text-spend-marketplace',
    container: 'border-spend-marketplace/15 bg-spend-marketplace/5',
    headerHover: 'hover:bg-spend-marketplace/10',
    itemBorder: 'border-spend-marketplace/20',
    itemHover: 'hover:bg-spend-marketplace/5',
  },
  vehicle: {
    text: 'text-spend-vehicle',
    container: 'border-spend-vehicle/15 bg-spend-vehicle/5',
    headerHover: 'hover:bg-spend-vehicle/10',
    itemBorder: 'border-spend-vehicle/20',
    itemHover: 'hover:bg-spend-vehicle/5',
  },
  loans: {
    text: 'text-warning',
    container: 'border-warning/15 bg-warning/5',
    headerHover: 'hover:bg-warning/10',
    itemBorder: 'border-warning/20',
    itemHover: 'hover:bg-warning/5',
  },
  fixed: {
    text: 'text-info',
    container: 'border-info/15 bg-info/5',
    headerHover: 'hover:bg-info/10',
    itemBorder: 'border-info/20',
    itemHover: 'hover:bg-info/5',
  },
  other: {
    text: 'text-spend-other',
    container: 'border-spend-other/15 bg-spend-other/5',
    headerHover: 'hover:bg-spend-other/10',
    itemBorder: 'border-spend-other/20',
    itemHover: 'hover:bg-spend-other/5',
  },
};

export type CollapsibleSpendingSectionProps = {
  tone: SpendingTone;
  icon: LucideIcon;
  title: string;
  badge?: React.ReactNode;
  total: number;
  defaultOpen?: boolean;
  bodyClassName?: string;
  children: React.ReactNode;
};

export function CollapsibleSpendingSection({
  tone,
  icon: Icon,
  title,
  badge,
  total,
  defaultOpen = true,
  bodyClassName = 'space-y-2 px-4 pb-4',
  children,
}: CollapsibleSpendingSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const toneClasses = SPENDING_TONES[tone];

  return (
    <section className={cn('overflow-hidden rounded-xl border', toneClasses.container)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex w-full items-center justify-between px-4 py-3 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          toneClasses.headerHover,
        )}
        aria-expanded={open}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={cn(
              'size-4 shrink-0 transition-transform',
              toneClasses.text,
              open && 'rotate-90',
            )}
          />
          <Icon className={cn('size-4 shrink-0', toneClasses.text)} aria-hidden="true" />
          <span className={cn('truncate font-heading font-semibold', toneClasses.text)}>
            {title}
          </span>
          {badge}
        </div>
        <span className={cn('shrink-0 font-numeric font-bold tabular-nums', toneClasses.text)}>
          {formatCurrency(Math.abs(total))}
        </span>
      </button>

      {open && <div className={bodyClassName}>{children}</div>}
    </section>
  );
}
