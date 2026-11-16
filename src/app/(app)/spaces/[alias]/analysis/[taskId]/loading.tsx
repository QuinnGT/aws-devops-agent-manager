import { Skeleton } from "@/components/ui/skeleton";
import { CardSkeleton, LoadingPage } from "../../journals/_components/skeletons";

/** One investigation's analysis while it loads: the run panel, then the analyzer tabs. */
export default function InvestigationAnalysisLoading() {
  return (
    <LoadingPage>
      <CardSkeleton className="h-32" />
      <div className="overflow-hidden rounded-xl border">
        <div className="flex gap-3 border-b px-4 py-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-6 w-28" />
          ))}
        </div>
        <div className="space-y-3 p-4">
          <Skeleton className="h-4 w-80" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </LoadingPage>
  );
}
