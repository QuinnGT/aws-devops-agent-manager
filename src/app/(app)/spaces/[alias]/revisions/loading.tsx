import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Revisions list while it loads (pages/revisions.md "States"): header, the filter toolbar and six table rows. */
export default function RevisionsLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <div className="space-y-px overflow-hidden rounded-xl border" aria-hidden>
        <Skeleton className="h-12 rounded-none" />
        <Skeleton className="h-9 rounded-none opacity-80" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-14 rounded-none opacity-60" />
        ))}
      </div>
    </div>
  );
}
