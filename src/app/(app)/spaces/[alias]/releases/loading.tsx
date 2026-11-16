import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Releases list while it loads: header with two actions, then the table card. */
export default function ReleasesLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <div className="space-y-px overflow-hidden rounded-xl border" aria-hidden>
        <Skeleton className="h-12 rounded-none" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 rounded-none opacity-60" />
        ))}
      </div>
    </div>
  );
}
