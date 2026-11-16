import type { ReactNode } from "react";
import { HeaderSkeleton } from "@/components/common/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** loading.tsx building blocks for the journals and analysis pages. */

export function LoadingPage({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <HeaderSkeleton />
      <div className="space-y-4" aria-hidden>
        {children}
      </div>
    </div>
  );
}

export function TabsSkeleton() {
  return (
    <div className="flex gap-3 border-b pb-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-6 w-28" />
      ))}
    </div>
  );
}

/** A card with a header bar, an optional toolbar and `rows` table rows. */
export function TableCardSkeleton({ rows = 8, toolbar = true }: { rows?: number; toolbar?: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="flex min-h-12 items-center border-b px-4">
        <Skeleton className="h-4 w-40" />
      </div>
      {toolbar ? (
        <div className="flex gap-2 border-b px-4 py-2.5">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-56" />
        </div>
      ) : null}
      <div className="h-8 bg-muted" />
      <div className="divide-y">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-3 py-3">
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="ml-auto h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardSkeleton({ className = "h-48" }: { className?: string }) {
  return <Skeleton className={`${className} w-full rounded-xl`} />;
}
