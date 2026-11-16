import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** History while it loads: header, the filter toolbar and feed rows under a day header. */
export default function HistoryLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <div className="overflow-hidden rounded-xl border" aria-hidden>
        <Skeleton className="h-12 rounded-none" />
        <div className="flex flex-wrap gap-2 border-t px-4 py-2.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-7 w-32" />
          ))}
          <Skeleton className="h-7 w-56" />
        </div>
        <Skeleton className="h-7 rounded-none" />
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="grid grid-cols-[120px_minmax(0,1fr)_80px] gap-4 border-t px-4 py-3">
            <Skeleton className="h-6 w-24" />
            <div className="space-y-1.5">
              <Skeleton className="h-5 w-64" />
              <Skeleton className="h-4 w-96 max-w-full" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
