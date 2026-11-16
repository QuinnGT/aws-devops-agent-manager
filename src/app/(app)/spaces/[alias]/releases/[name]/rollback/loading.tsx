import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Rollback preview while it loads: header, the grouped table and the plan card. */
export default function RollbackPreviewLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]" aria-hidden>
        <div className="space-y-px overflow-hidden rounded-xl border">
          <Skeleton className="h-12 rounded-none" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-14 rounded-none opacity-60" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
