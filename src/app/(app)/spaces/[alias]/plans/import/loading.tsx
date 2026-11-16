import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** The upload page while it loads: header, the upload card and the side card. */
export default function ImportPackageLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]" aria-hidden>
        <Skeleton className="h-[456px] rounded-xl" />
        <Skeleton className="h-52 rounded-xl" />
      </div>
    </div>
  );
}
