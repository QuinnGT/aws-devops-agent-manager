import { LoadingPage, TableCardSkeleton } from "../journals/_components/skeletons";

/** Analysis list while it loads: header and the investigations table with its run panel. */
export default function AnalysisLoading() {
  return (
    <LoadingPage>
      <TableCardSkeleton rows={10} />
    </LoadingPage>
  );
}
