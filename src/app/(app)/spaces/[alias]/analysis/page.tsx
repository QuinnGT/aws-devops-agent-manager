import Link from "next/link";
import { notFound } from "next/navigation";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { Time } from "@/components/common/time";
import { Card } from "@/components/ui/card";
import { listInvestigations } from "@/server/analyzers/store";
import { can, requireUserOrRedirect } from "@/server/auth/dal";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { FilterToolbar } from "../journals/_components/filter-toolbar";
import { filterHref, isFiltered, parseInvestigationFilters } from "../journals/_components/filters";
import { outlineSm, Pager, primarySm } from "../journals/_components/shared";
import { SOURCE_LABELS } from "../journals/_components/words";
import { analyzerOptions } from "./options";
import { toAnalysisRow } from "./rows";
import { InvestigationsTable, type InvestigationRowView } from "./run-analyzers";

const PAGE_SIZE = 50;

export default async function AnalysisPage({ params, searchParams }: PageProps<"/spaces/[alias]/analysis">) {
  const user = await requireUserOrRedirect();
  const { alias } = await params;
  const space = await getSpaceByAlias(alias);
  if (!space || !(await can(user, "audits.read", space.id))) notFound();
  const [canRun, canExport, canImport] = await Promise.all([can(user, "audits.run", space.id), can(user, "journals.export", space.id), can(user, "journals.import", space.id)]);

  const filters = parseInvestigationFilters(await searchParams);
  const { rows, total } = await listInvestigations(space.id, {
    limit: PAGE_SIZE,
    offset: (filters.page - 1) * PAGE_SIZE,
    q: filters.q || undefined,
    sources: filters.sources,
  });
  const base = `/spaces/${encodeURIComponent(space.alias)}/analysis`;
  const journals = `/spaces/${encodeURIComponent(space.alias)}/journals`;
  const filtered = isFiltered(filters);

  const view: InvestigationRowView[] = rows.map((r) => ({
    ...toAnalysisRow(r, base),
    analyzedAt: r.metricsAt ? <Time value={r.metricsAt} format="datetime" /> : null,
  }));

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Analysis" }]} />
      <PageHeader
        title="Analysis"
        description={`Analyzer results for the investigations cached in ${space.displayName ?? space.alias}, pulled or imported. Metrics come from the latest run-metrics output.`}
      />
      <Card className="gap-0 py-0" role="region" aria-labelledby="analysis-h">
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
          <h2 id="analysis-h" className="text-sm font-semibold tabular-nums">
            {total === 0 && !filtered ? "Investigations" : `${total} ${total === 1 ? "investigation" : "investigations"}${filtered ? " match" : ""}`}
          </h2>
          <span className="text-xs text-muted-foreground">Newest first</span>
        </div>
        {total > 0 || filtered ? (
          <FilterToolbar
            label="Filter investigations"
            menus={[{ param: "source", name: "Source", selected: filters.sources, options: [{ value: "api", label: SOURCE_LABELS.api }, { value: "import", label: SOURCE_LABELS.import }] }]}
            search={{ value: filters.q, label: "Filter by task ID, incident ID or title" }}
          />
        ) : null}
        {total === 0 ? (
          filtered ? (
            <EmptyState
              title="No investigations match these filters"
              action={
                <Link className={outlineSm} href={base}>
                  Clear filters
                </Link>
              }
            >
              Change or clear the filters to see other investigations.
            </EmptyState>
          ) : (
            <EmptyState
              title="No investigations to analyze yet"
              action={
                canExport ? (
                  <Link className={primarySm} href={`${journals}/exports`}>
                    Export journals
                  </Link>
                ) : canImport ? (
                  <Link className={outlineSm} href={`${journals}/imports`}>
                    Import journals
                  </Link>
                ) : undefined
              }
            >
              Analyzers run on cached journals. Export journals from the space or import journal files first.
            </EmptyState>
          )
        ) : (
          <InvestigationsTable alias={space.alias} rows={view} options={analyzerOptions()} canRun={canRun} />
        )}
        <Pager page={filters.page} pageSize={PAGE_SIZE} total={total} noun="investigations" hrefFor={(page) => filterHref(base, filters, { page })} />
      </Card>
    </div>
  );
}
