import { TopBar } from "@/components/app-shell/top-bar";
import { Skeleton } from "@/components/ui/skeleton";

/** The asset page while it loads: header with icon and actions, tabs, the content card and the versions card. */
export default function AssetLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <TopBar crumbs={[]} right={<Skeleton className="h-7 w-40" />} />
      <div className="flex flex-wrap items-start justify-between gap-4" aria-hidden>
        <div className="flex gap-3">
          <Skeleton className="size-10 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-4 w-[28rem] max-w-full" />
            <Skeleton className="h-4 w-80" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-28" />
        </div>
      </div>
      <div className="flex gap-4 border-b pb-2" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-6 w-20" />
        ))}
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]" aria-hidden>
        <Skeleton className="h-[480px] rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </div>
  );
}
