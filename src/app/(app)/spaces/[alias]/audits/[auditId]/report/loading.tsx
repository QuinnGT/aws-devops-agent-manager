import { Skeleton } from "@/components/ui/skeleton";

/** The Report tab while it loads, inside the audit layout: the help line, section cards and the two side cards. */
export default function AuditReportLoading() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]" aria-busy="true">
      <span className="sr-only" role="status">
        Loading the report
      </span>
      <div className="min-w-0 space-y-4" aria-hidden>
        <Skeleton className="h-4 w-[36rem] max-w-full" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-px overflow-hidden rounded-xl border">
            <Skeleton className="h-12 rounded-none" />
            <Skeleton className="h-8 rounded-none opacity-70" />
            {[0, 1, 2].map((j) => (
              <Skeleton key={j} className="h-10 rounded-none opacity-50" />
            ))}
          </div>
        ))}
      </div>
      <div className="grid content-start gap-4 lg:grid-cols-2 xl:grid-cols-1" aria-hidden>
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
