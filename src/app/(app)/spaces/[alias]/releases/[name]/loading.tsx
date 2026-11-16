import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Release detail while it loads: header, four stat tiles and the manifest table. */
export default function ReleaseDetailLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="space-y-px overflow-hidden rounded-xl border" aria-hidden>
        <Skeleton className="h-12 rounded-none" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-14 rounded-none opacity-60" />
        ))}
      </div>
    </div>
  );
}
