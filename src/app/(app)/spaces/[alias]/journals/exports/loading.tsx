import { CardSkeleton, LoadingPage, TableCardSkeleton, TabsSkeleton } from "../_components/skeletons";

/** Exports while they load: header, tabs, the new export form and the export list. */
export default function ExportsLoading() {
  return (
    <LoadingPage>
      <TabsSkeleton />
      <CardSkeleton className="h-72" />
      <TableCardSkeleton rows={4} toolbar={false} />
    </LoadingPage>
  );
}
