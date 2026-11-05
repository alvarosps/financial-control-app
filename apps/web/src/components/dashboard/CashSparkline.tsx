'use client';

import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

export type CashSparklinePoint = { date: string; total: number };

/** A compact 30-day cash trend; the adjacent KPI provides the full value. */
export function CashSparkline({
  points,
  ariaLabel,
}: {
  points: CashSparklinePoint[];
  ariaLabel: string;
}) {
  const reduced = usePrefersReducedMotion();

  return (
    <div className="h-16 w-44" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 176, height: 64 }}>
        <LineChart data={points} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Line
            type="monotone"
            dataKey="total"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={!reduced}
            animationDuration={220}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
