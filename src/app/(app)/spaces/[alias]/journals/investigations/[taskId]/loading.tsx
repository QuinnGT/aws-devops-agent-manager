import { CardSkeleton, LoadingPage } from "../../_components/skeletons";

/** One investigation while it loads: records beside the details and executions cards. */
export default function InvestigationLoading() {
  return (
    <LoadingPage>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <CardSkeleton className="h-[640px]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <CardSkeleton className="h-72" />
          <CardSkeleton className="h-40" />
        </div>
      </div>
    </LoadingPage>
  );
}
