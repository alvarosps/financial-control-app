import type * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type StatTone = 'brand' | 'income' | 'expense' | 'neutral';

export type StatCardProps = {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  tone?: StatTone;
  delta?: { label: string; direction: 'up' | 'down' | 'neutral' };
  surface?: 'solid' | 'glass';
  className?: string;
};

const valueTone: Record<StatTone, string> = {
  brand: 'text-foreground',
  income: 'text-income',
  expense: 'text-expense',
  neutral: 'text-foreground',
};

const iconTone: Record<StatTone, string> = {
  brand: 'bg-primary/15 text-primary',
  income: 'bg-income/15 text-income',
  expense: 'bg-expense/15 text-expense',
  neutral: 'bg-muted text-muted-foreground',
};

const deltaTone = {
  up: 'text-income',
  down: 'text-expense',
  neutral: 'text-muted-foreground',
} as const;

export function StatCard({
  label,
  value,
  icon,
  tone = 'neutral',
  delta,
  surface = 'solid',
  className,
}: StatCardProps) {
  return (
    <Card
      surface={surface}
      className={cn(
        'motion-safe:transition-[transform,box-shadow] motion-safe:duration-200 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md',
        className,
      )}
    >
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          {icon && (
            <span className={cn('grid size-8 place-items-center rounded-lg', iconTone[tone])}>
              {icon}
            </span>
          )}
        </div>
        <span className={cn('font-numeric text-2xl font-bold tabular-nums', valueTone[tone])}>
          {value}
        </span>
        {delta && (
          <span
            className={cn(
              'font-numeric text-xs font-medium tabular-nums',
              deltaTone[delta.direction],
            )}
          >
            {delta.label}
          </span>
        )}
      </CardContent>
    </Card>
  );
}
