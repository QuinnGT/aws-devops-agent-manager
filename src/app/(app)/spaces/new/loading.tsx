import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Register a space: header, the info callout and the three form sections. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <div className="max-w-4xl space-y-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    </div>
  );
}
