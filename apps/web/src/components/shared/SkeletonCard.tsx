export function SkeletonCard() {
  return (
    <div data-testid="skeleton-card" className="rounded-xl border bg-card p-6 animate-pulse">
      <div className="h-4 w-24 bg-muted rounded mb-4" />
      <div className="h-8 w-32 bg-muted rounded mb-2" />
      <div className="h-3 w-20 bg-muted rounded" />
    </div>
  );
}
