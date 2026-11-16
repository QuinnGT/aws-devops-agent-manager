import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Revision detail while it loads (revision-detail.md "States"): the header, the tabs, then the tree, editor and rail. */
export default function RevisionLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <Skeleton className="h-9 w-full rounded-none opacity-60" aria-hidden />
      <div className="grid items-start gap-4 min-[900px]:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_300px]" aria-hidden>
        <Skeleton className="hidden h-96 rounded-xl min-[900px]:block" />
        <Skeleton className="h-[560px] rounded-xl" />
        <div className="grid gap-4 sm:grid-cols-2 min-[900px]:col-span-2 xl:col-span-1 xl:grid-cols-1">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
