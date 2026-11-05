import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { skeletonKeys } from '@/lib/skeleton-keys';

export default function Loading() {
  return (
    <div className="space-y-8">
      <div>
        <div className="h-7 w-24 bg-muted rounded animate-pulse" />
        <div className="h-4 w-64 bg-muted rounded animate-pulse mt-1" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {skeletonKeys(6).map((key) => (
          <SkeletonCard key={key} />
        ))}
      </div>
    </div>
  );
}
