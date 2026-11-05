import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

type MeterTone = 'brand' | 'income' | 'expense' | 'warning' | 'info';

export type ProgressMeterProps = {
  current: number;
  total: number;
  /** Left-side label; defaults to `current/total`. */
  label?: string;
  tone?: MeterTone;
  className?: string;
};

function thresholdTone(pct: number): MeterTone {
  if (pct >= 75) return 'income';
  if (pct >= 25) return 'info';
  return 'brand';
}

export function ProgressMeter({ current, total, label, tone, className }: ProgressMeterProps) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const resolved = tone ?? thresholdTone(pct);
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium font-numeric tabular-nums">
          {label ?? `${current}/${total}`}
        </span>
        <span className="font-numeric tabular-nums text-muted-foreground">{pct}%</span>
      </div>
      <Progress value={current} max={total} tone={resolved} />
    </div>
  );
}
