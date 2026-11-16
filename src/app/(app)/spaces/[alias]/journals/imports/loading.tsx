import { CardSkeleton, LoadingPage, TableCardSkeleton, TabsSkeleton } from "../_components/skeletons";

/** Imports while they load: header, tabs, the upload card beside its rules, and the import list. */
export default function ImportsLoading() {
  return (
    <LoadingPage>
      <TabsSkeleton />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <CardSkeleton className="h-52" />
        <CardSkeleton className="h-52" />
      </div>
      <TableCardSkeleton rows={4} toolbar={false} />
    </LoadingPage>
  );
}
