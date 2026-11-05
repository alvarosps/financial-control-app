import { skeletonKeys } from '@/lib/skeleton-keys';
import { cn } from '@/lib/utils';

const BAR_HEIGHTS = [45, 70, 55, 80, 35, 60] as const;

/** Chart-specific loading state: title bar + ghost axes + pulsing bars. */
export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-xl border bg-card p-6', className)} aria-hidden="true">
      <div className="mb-4 h-4 w-32 motion-safe:animate-pulse rounded bg-muted" />
      <div className="flex h-56 items-end gap-3 border-b border-l border-border/60 p-2">
        {skeletonKeys(BAR_HEIGHTS.length).map((key, index) => (
          <div
            key={key}
            className="w-full motion-safe:animate-pulse rounded-t bg-muted/60"
            style={{ height: `${BAR_HEIGHTS[index]}%` }}
          />
        ))}
      </div>
    </div>
  );
}
