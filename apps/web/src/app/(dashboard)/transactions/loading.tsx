import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { skeletonKeys } from '@/lib/skeleton-keys';

export default function Loading() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-7 w-32 bg-muted rounded animate-pulse" />
        <div className="h-4 w-44 bg-muted rounded animate-pulse mt-1" />
      </div>
      <SkeletonCard />
      <div className="space-y-3">
        {skeletonKeys(8).map((key) => (
          <SkeletonCard key={key} />
        ))}
      </div>
    </div>
  );
}
