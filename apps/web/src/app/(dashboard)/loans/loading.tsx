import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { skeletonKeys } from '@/lib/skeleton-keys';

export default function Loading() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-7 w-28 bg-muted rounded animate-pulse" />
        <div className="h-4 w-52 bg-muted rounded animate-pulse mt-1" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {skeletonKeys(4).map((key) => (
          <SkeletonCard key={key} />
        ))}
      </div>
    </div>
  );
}
