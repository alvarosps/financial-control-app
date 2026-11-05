import { SkeletonCard } from '@/components/shared/SkeletonCard';

export default function Loading() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-7 w-32 bg-muted rounded animate-pulse" />
        <div className="h-4 w-56 bg-muted rounded animate-pulse mt-1" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    </div>
  );
}
