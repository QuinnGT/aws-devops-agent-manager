import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Audit log: header, then the events card with its filter toolbar and table rows. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <div className="space-y-0 overflow-hidden rounded-xl border">
        <Skeleton className="h-12 w-full rounded-none" />
        <div className="flex gap-2 border-b px-4 py-2.5">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-7 w-44" />
        </div>
        <div className="space-y-3 p-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
