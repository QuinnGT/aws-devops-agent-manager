import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** loading.tsx bodies for the plan and draft pages, matching each layout. */

function Busy({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      {children}
    </div>
  );
}

/** Plans and Drafts: tabs and one table card. */
export function PlansListSkeleton() {
  return (
    <Busy>
      <div className="flex gap-4 border-b pb-2" aria-hidden>
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-20" />
      </div>
      <div className="space-y-px overflow-hidden rounded-xl border" aria-hidden>
        <Skeleton className="h-12 w-full rounded-none" />
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-none opacity-70" />
        ))}
      </div>
    </Busy>
  );
}

/** Plan review: callout, four tiles, items and diff on the left, two side cards. */
export function PlanReviewSkeleton() {
  return (
    <Busy>
      <Skeleton className="h-14 w-full rounded-lg" aria-hidden />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]" aria-hidden>
        <div className="space-y-4">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    </Busy>
  );
}

/** Draft editor: header, a tab row, one 520 px block for the editor, and two side cards. */
export function DraftEditorSkeleton() {
  return (
    <Busy>
      <div className="flex gap-4 border-b pb-2" aria-hidden>
        <Skeleton className="h-6 w-14" />
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-6 w-32" />
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]" aria-hidden>
        <Skeleton className="h-[520px] rounded-xl" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      </div>
    </Busy>
  );
}
