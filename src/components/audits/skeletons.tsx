import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** loading.tsx bodies for the audit pages, matching each layout (pages/audits.md and the others, "Loading"). */

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

const Rows = ({ n, h = "h-14" }: { n: number; h?: string }) => (
  <div className="space-y-px overflow-hidden rounded-xl border" aria-hidden>
    <Skeleton className="h-12 w-full rounded-none" />
    {Array.from({ length: n }, (_, i) => (
      <Skeleton key={i} className={`${h} w-full rounded-none opacity-70`} />
    ))}
  </div>
);

/** Audits list: a toolbar row and six table rows. */
export function AuditListSkeleton() {
  return (
    <Busy>
      <Rows n={6} />
    </Busy>
  );
}

/** New audit and a draft: two cards on the left and two on the right. */
export function AuditFormSkeleton() {
  return (
    <Busy>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]" aria-hidden>
        <div className="space-y-4">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      </div>
    </Busy>
  );
}

/** Tab content only (the layout's header stays). */
export function AuditTabSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <Rows n={10} h="h-12" />
    </div>
  );
}

/** Incident review: two cards on the left and three finding cards on the right. */
export function AuditItemSkeleton() {
  return (
    <Busy>
      <div className="grid items-start gap-4 xl:grid-cols-[5fr_6fr]" aria-hidden>
        <div className="space-y-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
        </div>
      </div>
    </Busy>
  );
}
