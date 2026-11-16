import { TopBar } from "@/components/app-shell/top-bar";
import { Skeleton } from "@/components/ui/skeleton";

/** Top bar and page header placeholders shared by loading.tsx files. */
export function HeaderSkeleton() {
  return (
    <>
      <TopBar crumbs={[]} right={<Skeleton className="h-7 w-40" />} />
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
    </>
  );
}

/** loading.tsx body for a page with a header and one card. */
export function PageSkeleton() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
