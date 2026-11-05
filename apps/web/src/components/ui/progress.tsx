import type * as React from 'react';
import { cn } from '@/lib/utils';

type ProgressTone = 'brand' | 'income' | 'expense' | 'warning' | 'info';

const toneFill: Record<ProgressTone, string> = {
  brand: 'gradient-brand',
  income: 'bg-income',
  expense: 'bg-expense',
  warning: 'bg-warning',
  info: 'bg-info',
};

export type ProgressProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  value: number;
  max?: number;
  tone?: ProgressTone;
};

export function Progress({ value, max = 100, tone = 'brand', className, ...props }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${Math.round(pct)}%`}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        data-slot="progress-fill"
        className={cn('h-full rounded-full transition-[width] duration-500', toneFill[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
