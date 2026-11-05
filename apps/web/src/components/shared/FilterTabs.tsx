'use client';

import type * as React from 'react';
import { cn } from '@/lib/utils';

export type FilterTab = {
  key: string;
  label: string;
  count?: number;
  icon?: React.ReactNode;
};

export type FilterTabsProps = {
  tabs: FilterTab[];
  value: string;
  onValueChange: (key: string) => void;
  className?: string;
};

export function FilterTabs({ tabs, value, onValueChange, className }: FilterTabsProps) {
  return (
    <div
      role="tablist"
      className={cn('inline-flex items-center gap-1 rounded-xl glass p-1', className)}
    >
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onValueChange(tab.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.count != null && (
              <span className="font-numeric tabular-nums opacity-70">({tab.count})</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
