import type * as React from 'react';
import { cn } from '@/lib/utils';

export type PayoffMeterProps = {
  label: string;
  amount: React.ReactNode;
  savingsLabel?: string;
  savingsValue?: React.ReactNode;
  className?: string;
};

export function PayoffMeter({
  label,
  amount,
  savingsLabel,
  savingsValue,
  className,
}: PayoffMeterProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between rounded-xl border border-income/25 bg-income/[0.07] px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-wider text-income">{label}</p>
        <p className="text-lg font-bold font-numeric tabular-nums text-income">{amount}</p>
      </div>
      {savingsValue != null && (
        <div className="text-right">
          {savingsLabel && (
            <p className="text-[10px] uppercase tracking-wider text-income">{savingsLabel}</p>
          )}
          <p className="text-sm font-semibold font-numeric tabular-nums text-income">
            {savingsValue}
          </p>
        </div>
      )}
    </div>
  );
}
