import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** The Verification tab while it loads: header, tabs, the context line and both check cards. */
export default function ReleaseVerificationLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <Skeleton className="h-9 w-72 rounded-md" aria-hidden />
      <Skeleton className="h-4 w-[560px] max-w-full rounded-md" aria-hidden />
      <div className="space-y-px overflow-hidden rounded-xl border" aria-hidden>
        <Skeleton className="h-12 rounded-none" />
        <Skeleton className="h-10 rounded-none opacity-70" />
        <Skeleton className="h-14 rounded-none opacity-60" />
      </div>
      <div className="space-y-px overflow-hidden rounded-xl border" aria-hidden>
        <Skeleton className="h-12 rounded-none" />
        <Skeleton className="h-14 rounded-none opacity-70" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 rounded-none opacity-60" />
        ))}
      </div>
    </div>
  );
}
