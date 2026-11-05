'use client';

import type { ReactElement } from 'react';
import { type ChartConfig, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { formatCurrency } from '@/lib/format';

/** Money cell for chart tooltips: BRL for numbers, em dash for gaps. */
export function formatTooltipMoney(value: unknown): string {
  if (value == null) return '—';
  return typeof value === 'number' ? formatCurrency(value) : String(value);
}

/**
 * The one chart tooltip. Call it as a function inside a recharts chart —
 * `{moneyTooltip(chartConfig)}` — so recharts sees the real Tooltip type.
 */
export function moneyTooltip(config: ChartConfig): ReactElement {
  return (
    <ChartTooltip
      content={
        <ChartTooltipContent
          formatter={(value, name) => (
            <div className="flex w-full items-center justify-between gap-3">
              <span className="text-muted-foreground">{config[String(name)]?.label ?? name}</span>
              <span className="font-numeric font-medium text-foreground tabular-nums">
                {formatTooltipMoney(value)}
              </span>
            </div>
          )}
        />
      }
    />
  );
}
