import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** The asset list while it loads: header, the type links and two sections of rows. */
export default function AssetsLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <div className="flex gap-2" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-7 w-28" />
        ))}
      </div>
      {[6, 9].map((rows) => (
        <div key={rows} className="space-y-0 overflow-hidden rounded-xl border" aria-hidden>
          <Skeleton className="h-12 rounded-none" />
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_176px_80px_256px] gap-4 border-t px-4 py-2.5">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="ml-auto h-5 w-10" />
              <Skeleton className="h-5 w-40" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
