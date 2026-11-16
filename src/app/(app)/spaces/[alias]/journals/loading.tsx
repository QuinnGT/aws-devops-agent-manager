import { LoadingPage, TableCardSkeleton, TabsSkeleton } from "./_components/skeletons";

/** Investigations list while it loads: header, tabs and the filtered table. */
export default function JournalsLoading() {
  return (
    <LoadingPage>
      <TabsSkeleton />
      <TableCardSkeleton rows={10} />
    </LoadingPage>
  );
}
